/**
 * Instance selection (design.md §3.5): WHERE do we connect?
 *
 * Since 2026-09-30 two DSH distributions coexist on this machine and share the
 * same ~/.dsh data root:
 *   - 桌面版 Electron App → http://127.0.0.1:19387, profile "desktop"
 *     (the port is a literal in dsh-desktop-host/lib/index.js — the host has NO
 *     port-fallback logic, so an occupied 19387 means the App fails to start
 *     rather than moving elsewhere);
 *   - 旧 CLI `dsh web`    → http://127.0.0.1:3080, profile "web".
 *
 * Hence the candidates are a CONSTANT TABLE, not a process→port scan: a generic
 * scanner would be pure cost for a known literal (and tasklist/netstat parsing is
 * locale-fragile on Windows). "No instance" simply means neither candidate
 * answered.
 *
 * This module deliberately has no vscode dependency so the resolution logic can
 * be exercised offline.
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { detectFlavor } from "./protocol.js";
import { log, warn } from "../log.js";

export const DESKTOP_APP_PORT = 19387;
export const LOCAL_WEB_PORT = 3080;
export const DEFAULT_BASE_URL = `http://127.0.0.1:${LOCAL_WEB_PORT}`;

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

/** Ordered candidates: desktop App first (0.2.0 + auto-update), then old CLI. */
export function candidateInstances(appPath?: string): DshInstance[] {
  return [
    {
      id: "desktop-app",
      label: "桌面版 DSH（DeepSeek Harness App）",
      baseUrl: `http://127.0.0.1:${DESKTOP_APP_PORT}`,
      kind: "desktop-app",
      profile: "desktop",
      appPath,
    },
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
  const probed: DshInstance[] = [];
  for (const candidate of candidateInstances(appPath)) {
    probed.push((await probe(candidate, timeoutMs)) ?? { ...candidate, running: false });
  }
  const instance = probed.find((p) => p.running);
  if (instance) {
    instance.permissionPreset = readPermissionPreset(opts.home, instance.profile);
    log(`[instances] selected ${instance.label} (${instance.baseUrl}, profile ${instance.profile ?? "?"})`);
  } else {
    log("[instances] no instance answered (desktop 19387 / local 3080 both down)");
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