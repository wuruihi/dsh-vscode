/**
 * Instance selection (design.md §3.5): WHERE do we connect?
 *
 * Two DSH distributions may coexist on this machine and share the same ~/.dsh
 * data root:
 *   - 桌面版 Electron App → profile "desktop"
 *   - 旧 CLI `dsh web`    → http://127.0.0.1:3080, profile "web".
 *
 * The desktop port MOVED (DSH 0.2.1, 2026-10-17): dsh-desktop-host now runs the
 * profile with `--port 0`, so the OS assigns an ephemeral port on every launch
 * (release note v0.2.1-alpha.1: “桌面端默认使用系统分配的端口，避免 Windows 保留
 * 端口范围导致应用无法启动”). ≤0.2.0 wrote the literal 19387 instead. The
 * candidates are therefore:
 *   discovered desktop ports (process → listening port, see
 *   `discoverDesktopPorts`) → legacy fixed 19387 → legacy CLI 3080.
 *
 * Discovery is a process→port scan on purpose: the port is no longer knowable
 * from a constant, and the desktop App publishes no port file. It only looks at
 * listeners owned by `DeepSeek Harness.exe` (not every local port), parses plain
 * numbers (locale independent), and always degrades to the fixed candidates when
 * PowerShell is unavailable or slow.
 *
 * This module uses no vscode API directly (logging goes through `src/log.ts`,
 * which the offline regression stubs), so the resolution logic can be exercised
 * without an extension host.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { detectFlavor } from "./protocol.js";
import { log, warn } from "../log.js";

/** Fixed port used by desktop App ≤ 0.2.0 (`--port 19387` in dsh-desktop-host).
 *  0.2.1+ assigns the port at launch, so this is a compatibility candidate only
 *  — the live port comes from `discoverDesktopPorts()`. */
export const DESKTOP_APP_PORT = 19387;
export const LOCAL_WEB_PORT = 3080;
export const DEFAULT_BASE_URL = `http://127.0.0.1:${LOCAL_WEB_PORT}`;

/** Desktop process name used for port discovery (the Electron main process). */
const DESKTOP_PROCESS_NAME = "DeepSeek Harness";
/** Never chase more than this many discovered ports; the first live one wins. */
const DISCOVERY_MAX_PORTS = 8;
/** Hard cap for the discovery PowerShell FALLBACK (fast path is tasklist+netstat
 *  at ~0.2-0.4s; the fallback only runs when the App is visible but its ports
 *  are not). */
const DISCOVERY_TIMEOUT_MS = 3000;

export type InstanceKind = "desktop-app" | "local-web" | "custom";

export interface DshInstance {
  id: string;
  label: string;
  baseUrl: string;
  kind: InstanceKind;
  /** DSH profile the instance runs (desktop | web | …) when known. */
  profile?: string;
  /** Desktop App executable (kind === "desktop-app"). */
  appPath?: string;
  /** Probe result: did this baseUrl answer? */
  running?: boolean;
  /** The server answered 401/403: flavor is known, a cookie is required. */
  needsAuth?: boolean;
  /** Live permission preset of the instance's profile (read from
   *  ~/.dsh/profiles/<profile>/cordis.patch.yml) — surfaced in the UI because
   *  attaching to the desktop profile means approval cards never appear. */
  permissionPreset?: string;
}

export interface InstanceResolveOptions {
  home: string;
  /** dsh-vscode.baseUrl as configured ("" / undefined = untouched default). */
  explicitBaseUrl?: string;
  timeoutMs?: number;
  /** Injection seam (offline tests / regressions). */
  probe?: (instance: DshInstance, timeoutMs: number) => Promise<DshInstance | undefined>;
  /** Injection seam for the desktop App executable lookup. */
  appExe?: () => string | undefined;
  /** Injection seam for the desktop port scan (offline tests / regressions). */
  discoverPorts?: () => Promise<number[]>;
}

export interface InstanceResolution {
  /** The instance to connect to; undefined = nothing answered. */
  instance?: DshInstance;
  /** Every candidate with its probe result, in probe order. */
  candidates: DshInstance[];
  /** True when the user pinned baseUrl explicitly (no probe of the others). */
  pinned: boolean;
}

const DESKTOP_DIR_NAME = "DeepSeek Harness";
const DESKTOP_EXE_NAME = "DeepSeek Harness.exe";

/** Desktop App executable by the documented install layout (sync, cheap). */
export function desktopAppExe(): string | undefined {
  const local = process.env.LOCALAPPDATA;
  if (!local) return undefined;
  const p = path.join(local, "Programs", DESKTOP_DIR_NAME, DESKTOP_EXE_NAME);
  return existsSync(p) ? p : undefined;
}

/** Same, with a registry fallback (per-user install may live elsewhere). */
export async function desktopAppExeResolved(): Promise<string | undefined> {
  return desktopAppExe() ?? (await registryInstallLocation());
}

function registryInstallLocation(): Promise<string | undefined> {
  const roots = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  return new Promise((resolve) => {
    let pending = roots.length;
    let settled = false;
    const done = (value?: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    for (const root of roots) {
      execFile(
        "reg",
        ["query", root, "/s", "/f", DESKTOP_DIR_NAME, "/d"],
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          if (!settled && !err && stdout) {
            const m = /InstallLocation\s+REG_SZ\s+(.+)/.exec(stdout);
            if (m) {
              const dir = m[1].trim();
              const exe = path.join(dir, DESKTOP_EXE_NAME);
              if (existsSync(exe)) return done(exe);
            }
          }
          if (--pending === 0) done(undefined);
        },
      );
    }
  });
}

/**
 * Listening ports held by the desktop App process (Windows only).
 *
 * DSH 0.2.1+ starts the desktop host with `--port 0`, so the live gateway port
 * changes on every launch and is published nowhere on disk. We ask Windows for
 * the listeners owned by the App's own process instead of scanning every local
 * port: `Get-Process` → owning PIDs → `Get-NetTCPConnection -State Listen`.
 *
 * Never throws: a missing PowerShell, a timeout, or a localized/odd output all
 * degrade to `[]`, and the caller falls back to the fixed candidates (the same
 * behavior as before discovery existed). The last failure is exposed through
 * `lastDesktopDiscoveryNote()` so the UI can say why auto-discovery is blind
 * instead of silently pretending no instance exists.
 */
let discoveryNote: string | undefined;

/** Why the last discovery returned nothing useful (undefined = success/skip). */
export function lastDesktopDiscoveryNote(): string | undefined {
  return discoveryNote;
}

/** Run one Windows CLI and capture stdout; never rejects. */
function capture(file: string, args: string[], timeoutMs: number): Promise<{ err?: Error; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve({ err: err ?? undefined, stdout: stdout ?? "" }),
    );
  });
}

/**
 * Fast path (~0.2-0.4s, no PowerShell): tasklist gives the App's PIDs, netstat
 * maps listening sockets to PIDs. Names/ports are pure ASCII; the listening
 * test uses the wildcard peer address (0.0.0.0:0 / [::]:0) instead of the
 * localized state word, so it does not depend on the OS language.
 */
async function discoverFast(): Promise<{ ports: number[]; sawProcess: boolean }> {
  const list = await capture("tasklist", ["/FI", `IMAGENAME eq ${DESKTOP_EXE_NAME}`, "/FO", "CSV", "/NH"], 2500);
  const pids = new Set<number>();
  for (const m of list.stdout.matchAll(/"([^"]+)","(\d+)"/g)) pids.add(Number(m[2]));
  if (pids.size === 0) return { ports: [], sawProcess: false };
  const net = await capture("netstat", ["-ano", "-p", "tcp"], 2500);
  const ports = new Set<number>();
  for (const line of net.stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0].toUpperCase() !== "TCP") continue;
    const pid = Number(cols[cols.length - 1]);
    if (!pids.has(pid)) continue;
    if (!/^(0\.0\.0\.0:0|\[::\]:0)$/.test(cols[2])) continue; // listening socket only
    const m = /:(\d+)$/.exec(cols[1]);
    if (!m) continue;
    const port = Number(m[1]);
    if (port > 0 && port <= 65535) ports.add(port);
  }
  return { ports: [...ports].sort((a, b) => a - b), sawProcess: true };
}

/**
 * Fallback (~2s): PowerShell when tasklist/netstat are unavailable or the App
 * listens through a bundled `node.exe` host. `NO_NETTCPIP` / `DISCOVERY_ERROR`
 * sentinels make the failure visible instead of silently returning nothing.
 */
async function discoverViaPowerShell(appPath: string | undefined, timeoutMs: number): Promise<number[]> {
  const installDir = appPath
    ? path.dirname(appPath)
    : path.join(process.env.LOCALAPPDATA ?? "", "Programs", DESKTOP_DIR_NAME);
  const escapedDir = installDir.replace(/'/g, "''");
  const script =
    "try { " +
    "if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { 'NO_NETTCPIP' } else { " +
    `$ids = @(Get-Process -Name '${DESKTOP_PROCESS_NAME}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); ` +
    "$ports = @(); " +
    "if ($ids.Count -gt 0) { $ports = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $ids -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort) }; " +
    "if (($ports.Count -eq 0) -and ($ids.Count -gt 0)) { " +
    `$dir = '${escapedDir}'; ` +
    "$more = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) } | " +
    "Select-Object -ExpandProperty ProcessId); " +
    "if ($more) { $ports = @(Get-NetTCPConnection -State Listen | Where-Object { $more -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort) } " +
    "}; " +
    "$ports | Sort-Object -Unique } } catch { 'DISCOVERY_ERROR' }";
  const res = await capture("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], timeoutMs);
  if (res.err) {
    discoveryNote = "端口自动发现失败（PowerShell 不可用或被策略禁止）";
    warn(`[instances] desktop port discovery failed: ${String(res.err)}`);
    return [];
  }
  if (res.stdout.includes("NO_NETTCPIP")) {
    discoveryNote = "端口自动发现不可用（系统缺少 NetTCPIP 模块）";
    return [];
  }
  if (res.stdout.includes("DISCOVERY_ERROR")) {
    discoveryNote = "端口自动发现失败（PowerShell 执行出错）";
    return [];
  }
  return [...new Set(
    res.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number),
  )]
    .filter((port) => port > 0 && port <= 65535)
    .sort((a, b) => a - b)
    .slice(0, DISCOVERY_MAX_PORTS);
}

/**
 * Listening ports held by the desktop App process (Windows only).
 *
 * DSH 0.2.1+ starts the desktop host with `--port 0`, so the live gateway port
 * changes on every launch and is published nowhere on disk. We ask Windows for
 * the listeners owned by the App's own process instead of scanning every local
 * port. Fast path = tasklist + netstat; PowerShell fallback only when the fast
 * path saw the App but produced no ports (or was unavailable).
 *
 * Never throws: failures degrade to `[]` and the caller falls back to the fixed
 * candidates; the reason is exposed via `lastDesktopDiscoveryNote()` so the UI
 * can say why auto-discovery is blind.
 */
export async function discoverDesktopPorts(appPath?: string, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<number[]> {
  if (process.platform !== "win32") return Promise.resolve([]);
  const fast = await discoverFast();
  if (fast.ports.length > 0) {
    discoveryNote = undefined;
    return fast.ports.slice(0, DISCOVERY_MAX_PORTS);
  }
  // No App process at all ⇒ nothing to discover; do NOT pay for the fallback.
  if (!fast.sawProcess) return [];
  const slow = await discoverViaPowerShell(appPath, timeoutMs);
  if (slow.length > 0) discoveryNote = undefined;
  return slow;
}

/** Ordered candidates: discovered desktop ports (ascending) first, then the
 *  legacy fixed port. `discoveredPorts` empty (non-Windows / discovery failed)
 *  reproduces the pre-port-discovery candidate table. */
export function candidateInstances(appPath?: string, discoveredPorts: number[] = []): DshInstance[] {
  const discovered = [...new Set(discoveredPorts)]
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
    .sort((a, b) => a - b);
  const desktopPorts = discovered.includes(DESKTOP_APP_PORT) ? discovered : [...discovered, DESKTOP_APP_PORT];
  return [
    ...desktopPorts.map((port) => ({
      id: port === DESKTOP_APP_PORT ? "desktop-app" : `desktop-app:${port}`,
      label: "桌面版 DSH（DeepSeek Harness App）",
      baseUrl: `http://127.0.0.1:${port}`,
      kind: "desktop-app" as const,
      profile: "desktop",
      appPath,
    })),
    {
      id: "local-web",
      label: "本地 dsh web（旧 CLI）",
      baseUrl: `http://127.0.0.1:${LOCAL_WEB_PORT}`,
      kind: "local-web",
      profile: "web",
    },
  ];
}

/** Does this candidate answer? Reuses the flavor probe: 401 also means "alive". */
export async function probeInstance(instance: DshInstance, timeoutMs = 1200): Promise<DshInstance | undefined> {
  try {
    const detected = await detectFlavor(instance.baseUrl, timeoutMs);
    return detected ? { ...instance, running: true, needsAuth: detected.needsAuth } : undefined;
  } catch (err) {
    warn(`[instances] probe ${instance.baseUrl} failed: ${String(err)}`);
    return undefined;
  }
}

export function profileOfBaseUrl(baseUrl: string): string | undefined {
  try {
    const port = new URL(baseUrl).port;
    if (port === String(DESKTOP_APP_PORT)) return "desktop";
    if (port === String(LOCAL_WEB_PORT)) return "web";
  } catch {
    /* not a URL — caller treats it as custom */
  }
  return undefined;
}

/** Live permission preset of a profile ("" when unknown). */
export function readPermissionPreset(home: string, profile?: string): string | undefined {
  if (!profile) return undefined;
  try {
    const file = path.join(home, ".dsh", "profiles", profile, "cordis.patch.yml");
    const m = /defaultPreset:\s*([A-Za-z0-9_-]+)/.exec(readFileSync(file, "utf8"));
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the instance to connect to.
 * Explicit (non-default) baseUrl wins and is never overridden — the escape
 * hatch. Otherwise candidates are probed in order and the first live one wins.
 */
export async function resolveInstance(opts: InstanceResolveOptions): Promise<InstanceResolution> {
  const probe = opts.probe ?? probeInstance;
  const timeoutMs = opts.timeoutMs ?? 1200;
  const explicit = (opts.explicitBaseUrl ?? "").trim();
  const pinned = explicit !== "" && explicit.replace(/\/+$/, "") !== DEFAULT_BASE_URL;

  if (pinned) {
    const instance: DshInstance = {
      id: "custom",
      label: `自定义地址 (${explicit})`,
      baseUrl: explicit,
      kind: "custom",
      profile: profileOfBaseUrl(explicit),
    };
    const alive = (await probe(instance, timeoutMs)) ?? { ...instance, running: false };
    return { instance: alive.running ? alive : undefined, candidates: [alive], pinned: true };
  }

  const appPath = opts.appExe ? opts.appExe() : desktopAppExe();
  let discovered: number[] = [];
  try {
    discovered = opts.discoverPorts ? await opts.discoverPorts() : await discoverDesktopPorts(appPath);
  } catch (err) {
    warn(`[instances] desktop port discovery threw, using fixed candidates: ${String(err)}`);
  }
  if (discovered.length > 0) log(`[instances] desktop app listening on ${discovered.join(", ")}`);
  const probed: DshInstance[] = [];
  for (const candidate of candidateInstances(appPath, discovered)) {
    probed.push((await probe(candidate, timeoutMs)) ?? { ...candidate, running: false });
  }
  const instance = probed.find((p) => p.running);
  if (instance) {
    instance.permissionPreset = readPermissionPreset(opts.home, instance.profile);
    log(`[instances] selected ${instance.label} (${instance.baseUrl}, profile ${instance.profile ?? "?"})`);
  } else {
    log(
      `[instances] no instance answered (desktop ${discovered.length > 0 ? discovered.join("/") : DESKTOP_APP_PORT} / local ${LOCAL_WEB_PORT} all down)`,
    );
  }
  return { instance, candidates: probed, pinned: false };
}

/** One-line identity for the status bar / quick pick. */
export function describeInstance(instance: DshInstance): string {
  const bits = [instance.baseUrl.replace(/^https?:\/\//, "")];
  if (instance.profile) bits.push(`profile ${instance.profile}`);
  if (instance.permissionPreset) bits.push(instance.permissionPreset);
  return bits.join(" · ");
}

/** Launch the desktop App (the preferred fallback: full feature set, no second
 *  writer, keeps auto-update) instead of starting our own web server. */
export function openDesktopApp(appPath: string): boolean {
  if (!existsSync(appPath)) {
    warn(`[instances] desktop app not found at ${appPath}`);
    return false;
  }
  try {
    const child = spawn(appPath, [], { detached: true, stdio: "ignore" });
    child.unref();
    log(`[instances] launched desktop app: ${appPath}`);
    return true;
  } catch (err) {
    warn(`[instances] desktop app launch failed: ${String(err)}`);
    return false;
  }
}

export interface WaitForDesktopOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Launch the App before polling (default true). */
  launch?: boolean;
  /** Harness home — used to surface the desktop profile's permission preset. */
  home?: string;
  /** Injection seams (offline tests / regressions). */
  probe?: (instance: DshInstance, timeoutMs: number) => Promise<DshInstance | undefined>;
  discoverPorts?: () => Promise<number[]>;
}

/**
 * Open the desktop App (unless already running) and attach to the port the OS
 * assigns it. The port is unknown until the host has listened, so this polls
 * discovery + flavor probe until one answers or the deadline passes. Returns a
 * `desktop-app` instance ready for `wireInstance` (baseUrl is fixed at
 * construction time, so callers must rebuild the connection generation) with
 * the same `permissionPreset` enrichment `resolveInstance` applies.
 */
export async function waitForDesktopInstance(
  appPath: string | undefined,
  opts: WaitForDesktopOptions = {},
): Promise<DshInstance | undefined> {
  if (opts.launch !== false) {
    if (!appPath || !openDesktopApp(appPath)) return undefined;
  }
  const probe = opts.probe ?? probeInstance;
  const intervalMs = opts.intervalMs ?? 1200;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    let ports: number[] = [];
    try {
      ports = opts.discoverPorts ? await opts.discoverPorts() : await discoverDesktopPorts(appPath);
    } catch (err) {
      warn(`[instances] port discovery threw while waiting for the app: ${String(err)}`);
    }
    for (const candidate of candidateInstances(appPath, ports)) {
      if (candidate.kind !== "desktop-app") continue;
      const alive = await probe(candidate, 1200);
      if (alive) {
        alive.permissionPreset = readPermissionPreset(opts.home ?? "", alive.profile);
        log(`[instances] desktop app answered on ${alive.baseUrl}`);
        return alive;
      }
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
