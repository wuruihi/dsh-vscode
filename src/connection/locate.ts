/**
 * Locating the two executables needed to start `dsh web`: the node executable
 * and the installed dsh CLI entry (`lib/bin.js`).
 *
 * Why this module exists (2026-09-17, user report "一键拉起失败"): both paths
 * used to come from settings whose package.json defaults were machine-specific
 * — the dsh one even contained the publisher's own user name — so on any other
 * machine "start dsh web" ran Start-Process against a file that does not exist
 * and only failed 120 s later with "did not become ready in 120s", with nothing
 * pointing at the path as the cause. Resolution is now: an explicit setting
 * wins (when it really is a dsh CLI), otherwise probe the usual install
 * locations, and report every candidate that was tried when nothing is found.
 *
 * Deliberately vscode-free so it stays unit-testable offline
 * (scripts/locate-regress.cjs) and dependency-free.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Path segments that identify an installed dsh CLI entry point. */
const DSH_TAIL = ["node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"];

export interface LocateHit {
  path: string;
  /** Where this candidate came from (logged, and shown when nothing is found). */
  source: string;
}

export interface LocateOutcome {
  hit?: LocateHit;
  /** Every candidate probed, in order, annotated with its source. */
  searched: string[];
  /** Set when the explicit setting pointed at something unusable. */
  explicitRejected?: string;
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** First 4 KB as text — enough to sniff a marker without reading a bundle. */
function headText(p: string): string {
  try {
    const fd = fs.openSync(p, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

/** True for a usable dsh CLI entry: normally
 *  `.../node_modules/@deepseek-ai/dsh/lib/bin.js`. A relocated-but-real file is
 *  accepted too, by the boot import marker its head carries. */
export function looksLikeDshBin(p: string): boolean {
  if (!isFile(p) || path.basename(p).toLowerCase() !== "bin.js") return false;
  const parts = p.split(/[\\/]/).map((s) => s.toLowerCase());
  const tail = parts.slice(-DSH_TAIL.length);
  const onConvention = tail.length === DSH_TAIL.length && DSH_TAIL.every((seg, i) => tail[i] === seg);
  return onConvention || headText(p).includes("dsh-app-boot");
}

export function looksLikeNodeExe(p: string): boolean {
  return isFile(p) && /^node(\.exe)?$/i.test(path.basename(p));
}

/** Nearest existing ancestor directory — used to point the file picker at a
 *  useful place instead of the filesystem root. */
export function nearestExistingDir(p: string, fallback: string): string {
  let dir = path.dirname(path.resolve(p));
  for (let i = 0; i < 12; i++) {
    if (isDir(dir)) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return fallback;
}

function envDirs(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(";")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function addCandidate(
  list: Array<[string, string]>,
  seen: Set<string>,
  p: string | undefined,
  source: string,
): void {
  if (!p) return;
  let norm: string;
  try {
    norm = path.resolve(p);
  } catch {
    return;
  }
  const key = norm.toLowerCase(); // Windows paths are case-insensitive
  if (seen.has(key)) return;
  seen.add(key);
  list.push([norm, source]);
}

function firstHit(
  candidates: Array<[string, string]>,
  accepts: (p: string) => boolean,
  explicitRejected: string | undefined,
): LocateOutcome {
  const searched = candidates.map(([p, source]) => `${p}  ← ${source}`);
  for (const [p, source] of candidates) {
    if (accepts(p)) return { hit: { path: p, source }, searched, explicitRejected };
  }
  return { searched, explicitRejected };
}

export interface LocateDshOptions {
  /** Value of the `dsh-vscode.dshBinPath` setting ("" = auto-detect). */
  explicit?: string;
  /** User home directory. */
  home: string;
  /** Extra roots to probe, e.g. the open workspace folders. */
  extraRoots?: string[];
}

export function locateDshBin(opts: LocateDshOptions): LocateOutcome {
  const candidates: Array<[string, string]> = [];
  const seen = new Set<string>();
  let explicitRejected: string | undefined;

  const explicit = (opts.explicit ?? "").trim();
  if (explicit) {
    if (looksLikeDshBin(explicit)) addCandidate(candidates, seen, explicit, "设置 dsh-vscode.dshBinPath");
    else explicitRejected = explicit;
  }

  const appData = process.env.APPDATA;
  if (appData) addCandidate(candidates, seen, path.join(appData, "npm", ...DSH_TAIL), "npm 全局（%APPDATA%\\npm）");
  const prefix = process.env.npm_config_prefix;
  if (prefix) addCandidate(candidates, seen, path.join(prefix, ...DSH_TAIL), "npm_config_prefix");
  const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES;
  if (programFiles) {
    addCandidate(candidates, seen, path.join(programFiles, "nodejs", ...DSH_TAIL), "Node 安装目录内的全局前缀");
  }
  addCandidate(candidates, seen, path.join(opts.home, "dsh", ...DSH_TAIL), "家目录本地部署（~/dsh）");
  addCandidate(candidates, seen, path.join(opts.home, ...DSH_TAIL), "家目录（~\\node_modules）");
  for (const dir of envDirs("PATH")) {
    addCandidate(candidates, seen, path.join(dir, ...DSH_TAIL), `PATH 前缀 ${dir}`);
  }
  for (const root of opts.extraRoots ?? []) {
    addCandidate(candidates, seen, path.join(root, ...DSH_TAIL), `工作区 ${root}`);
  }
  // npm's own answer goes last: it costs a process spawn (~1 s) and the PATH
  // probe already covers every prefix that happens to be on PATH.
  const npmRoot = npmGlobalRoot();
  if (npmRoot) addCandidate(candidates, seen, path.join(npmRoot, ...DSH_TAIL), "npm root -g");

  return firstHit(candidates, looksLikeDshBin, explicitRejected);
}

export interface LocateNodeOptions {
  /** Value of the `dsh-vscode.nodePath` setting ("" = auto-detect). */
  explicit?: string;
}

export function locateNodeExe(opts: LocateNodeOptions): LocateOutcome {
  const candidates: Array<[string, string]> = [];
  const seen = new Set<string>();
  let explicitRejected: string | undefined;

  const explicit = (opts.explicit ?? "").trim();
  if (explicit) {
    if (looksLikeNodeExe(explicit)) addCandidate(candidates, seen, explicit, "设置 dsh-vscode.nodePath");
    else explicitRejected = explicit;
  }

  const programFiles = process.env.ProgramFiles ?? process.env.PROGRAMFILES;
  if (programFiles) addCandidate(candidates, seen, path.join(programFiles, "nodejs", "node.exe"), "Node 标准安装目录");
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    addCandidate(candidates, seen, path.join(localAppData, "Programs", "nodejs", "node.exe"), "用户级 Node 安装目录");
  }
  for (const dir of envDirs("PATH")) {
    addCandidate(candidates, seen, path.join(dir, "node.exe"), `PATH 前缀 ${dir}`);
  }

  return firstHit(candidates, looksLikeNodeExe, explicitRejected);
}

/** `npm root -g`, guarded: missing npm, a slow npm and a non-directory answer
 *  all yield undefined instead of throwing. */
function npmGlobalRoot(): string | undefined {
  try {
    const out = execSync("npm root -g", {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    return first && isDir(first) ? first : undefined;
  } catch {
    return undefined;
  }
}
