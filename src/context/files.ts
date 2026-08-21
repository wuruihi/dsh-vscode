/**
 * Workspace file search for the @ completion in the composer.
 * Lists files via vscode.workspace.findFiles with a short-lived cache so
 * per-keystroke queries stay cheap; ranks by fuzzy relevance.
 */
import * as vscode from "vscode";

const EXCLUDE = "**/{node_modules,.git,dist,out,build,.venv,__pycache__,.next,coverage}/**";
const LIST_LIMIT = 5000;
const RESULT_LIMIT = 50;
const CACHE_TTL_MS = 5000;

export interface FileHit {
  path: string;
  rel: string;
}

let cache: { at: number; files: FileHit[] } | undefined;

async function allFiles(): Promise<FileHit[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.files;
  const uris = await vscode.workspace.findFiles("**/*", EXCLUDE, LIST_LIMIT);
  const files = uris.map((u) => ({ path: u.fsPath, rel: vscode.workspace.asRelativePath(u) }));
  cache = { at: Date.now(), files };
  return files;
}

/** Subsequence fuzzy match; returns score (higher = better) or -1. */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 1;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  const direct = h.indexOf(n);
  if (direct >= 0) {
    // substring hit: earlier + shorter path wins
    return 1000 - direct - haystack.length;
  }
  // subsequence walk
  let hi = 0;
  let score = 0;
  let streak = 0;
  for (const ch of n) {
    const idx = h.indexOf(ch, hi);
    if (idx < 0) return -1;
    streak = idx === hi ? streak + 2 : 0; // contiguous runs reward
    score += 1 + streak;
    hi = idx + 1;
  }
  return score - haystack.length / 100;
}

export async function searchWorkspaceFiles(query: string): Promise<FileHit[]> {
  const files = await allFiles();
  if (!query) {
    // no query: recently-useful default — shortest paths first (root files)
    return [...files].sort((a, b) => a.rel.length - b.rel.length).slice(0, RESULT_LIMIT);
  }
  const scored: { f: FileHit; s: number }[] = [];
  for (const f of files) {
    const s = Math.max(fuzzyScore(f.rel, query), fuzzyScore(basename(f.rel), query) - 50);
    if (s > 0) scored.push({ f, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, RESULT_LIMIT).map((x) => x.f);
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}
