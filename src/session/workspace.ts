/**
 * Workspace resolution: match the first workspace folder against
 * workspace.list by normalized path; create when missing.
 *
 * Known pitfall (from the Obsidian archaeology): Windows backslash/casing
 * mismatches caused duplicate creates that fail with realpath ENOENT —
 * always normalize both sides before comparing.
 */
import * as vscode from "vscode";
import type { RpcClient } from "../connection/client.js";
import { log } from "../log.js";

export interface WorkspaceRow {
  workspaceId: string;
  path: string;
  title?: string;
}

export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  s = s.replace(/\/+$/, "");
  return s;
}

export async function resolveWorkspace(client: RpcClient): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  const root = folders?.[0]?.uri.fsPath;
  if (!root) return undefined;
  const wanted = normalizePath(root);
  const res = await client.call<{ workspaces?: WorkspaceRow[]; items?: WorkspaceRow[] }>("workspace.list", {});
  const rows = res?.workspaces ?? res?.items ?? [];
  for (const row of rows) {
    if (normalizePath(row.path) === wanted) return row.workspaceId;
  }
  try {
    const created = await client.call<{ workspace: WorkspaceRow }>("workspace.create", { path: root });
    log(`[workspace] created ${created?.workspace?.workspaceId} for ${root}`);
    return created?.workspace?.workspaceId;
  } catch (err) {
    // Race with the GUI creating the same workspace: re-list and match.
    log(`[workspace] create failed (${String(err)}), retrying list`);
    const again = await client.call<{ workspaces?: WorkspaceRow[]; items?: WorkspaceRow[] }>("workspace.list", {});
    const rows2 = again?.workspaces ?? again?.items ?? [];
    for (const row of rows2) {
      if (normalizePath(row.path) === wanted) return row.workspaceId;
    }
    return undefined;
  }
}
