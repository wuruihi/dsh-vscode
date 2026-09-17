/**
 * Probe-session disk cleanup (wrap-up helper).
 *
 * Why this exists: DSH has **no session-delete API** — only
 * `workspace/archiveSession`, which merely hides a session from the sidebar and
 * keeps its files under ~/.dsh forever. So "leave no residue" needs two steps:
 * archive (UI) **and** delete files (disk). Test harnesses create sessions; this
 * module removes what they leave behind.
 *
 * Usage:
 *   const { purgeSessionFiles, logDirOf } = await import("./session-purge.mjs");
 *   await call("workspace/archiveSession", { sessionId }, 15_000, "v012"); // best effort
 *   purgeSessionFiles(sessionId);
 *
 * Deleted (located by the globally unique session id):
 *   ~/.dsh/sessions/--<cwd slug>--/session-<id>/                 session log (multi-frame zstd jsonl)
 *   ~/.dsh/storages/session_projcache/sessions/session-<id>.json projection cache
 *   the parent slug directory too, once it is empty
 * The id stays in the archive set (storages/workspace.json) — harmless: DSH
 * already tolerates archive entries whose files are gone, and rewriting that
 * file requires stopping the host.
 *
 * Best effort by design: cleanup must never turn a green test red.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const SESS_ROOT = path.join(HOME, ".dsh", "sessions");
const PROJ_CACHE = path.join(HOME, ".dsh", "storages", "session_projcache", "sessions");

/** Locate a session's log directory under ~/.dsh/sessions; null when absent. */
export function logDirOf(sessionId) {
  try {
    for (const d of fs.readdirSync(SESS_ROOT)) {
      const p = path.join(SESS_ROOT, d, sessionId);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* no sessions dir yet */
  }
  return null;
}

/** Delete a session's log dir + projection cache (and the slug dir once empty). */
export function purgeSessionFiles(sessionId) {
  const removed = [];
  const dir = logDirOf(sessionId);
  if (dir) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
      const parent = path.dirname(dir);
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmdirSync(parent);
        removed.push(parent);
      }
    } catch {
      /* locked or already gone */
    }
  }
  for (const p of [path.join(PROJ_CACHE, sessionId + ".json"), path.join(path.dirname(PROJ_CACHE), sessionId + ".json")]) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { force: true });
        removed.push(p);
      }
    } catch {
      /* ignore */
    }
  }
  return removed;
}
