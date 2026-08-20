/**
 * Native diff: collects edit-tool calls per turn for the current session and
 * serves reconstructed "before" documents under the dshdiff: scheme.
 *
 * URI: dshdiff:/<fsPath>?v=<seq>&turn=<n> — the seq version busts the content
 * provider cache; the same file re-edited later opens a fresh document.
 *
 * Reconstruction: read the file NOW, apply the turn's edit sequence in reverse
 * (new_string -> old_string). A miss (user hand-edited / overlapping edits)
 * skips that edit; the diff title then notes partial reconstruction.
 */
import * as vscode from "vscode";
import { log } from "../log.js";

export interface EditRecord {
  callId: string;
  filePath: string;
  oldString?: string;
  newString?: string;
}

interface TurnEdits {
  turn: number;
  edits: EditRecord[];
}

function looksEdit(name: string): boolean {
  const n = name.toLowerCase();
  return n === "edit" || n === "str-replace-editor" || n === "write" || n.includes("edit") || n.includes("write");
}

function normalizeFs(p: string): string {
  let s = p.replace(/\\/g, "/");
  if (/^[a-zA-Z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

function encodePath(p: string): string {
  return normalizeFs(p).split("/").map(encodeURIComponent).join("/");
}

function parseJson(raw: unknown): any {
  if (typeof raw !== "string") return raw ?? undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Pure reverse reconstruction. Returns content + whether any edit was skipped. */
function reconstruct(current: string, edits: EditRecord[]): { content: string; partial: boolean; misses: string[] } {
  let content = current;
  let partial = false;
  const misses: string[] = [];
  for (let i = edits.length - 1; i >= 0; i--) {
    const e = edits[i];
    if (!e.newString || e.oldString === undefined) continue;
    const idx = content.indexOf(e.newString);
    if (idx < 0) {
      partial = true;
      misses.push(e.callId);
      continue;
    }
    content = content.slice(0, idx) + e.oldString + content.slice(idx + e.newString.length);
  }
  return { content, partial, misses };
}

export class DiffService implements vscode.Disposable {
  private turns: TurnEdits[] = [];
  private turnCounter = 0;
  private latestByCall = new Map<string, { uri: vscode.Uri; turn: number }>();
  private disposables: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider("dshdiff", {
        provideTextDocumentContent: (uri) => this.content(uri),
        onDidChange: this.emitter.event,
      }),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.emitter.dispose();
  }

  /** Feed session events (current session only) — called from the manager. */
  onSessionEvent(ev: any): void {
    if (!ev || typeof ev.type !== "string") return;
    if (ev.type === "turn/start") {
      this.turnCounter += 1;
      this.turns.push({ turn: this.turnCounter, edits: [] });
      if (this.turns.length > 50) this.turns.splice(0, this.turns.length - 50);
      return;
    }
    if (ev.type !== "tool/call") return;
    const data = ev.data ?? {};
    if (!data.name || !looksEdit(data.name)) return;
    const args = parseJson(data.arguments);
    if (!args) return;
    const filePath = args.file_path ?? args.path ?? args.absolute_path;
    if (typeof filePath !== "string") return;
    const callId = String(data.callId ?? "");
    const rec: EditRecord = {
      callId,
      filePath,
      oldString: typeof args.old_string === "string" ? args.old_string : undefined,
      newString: typeof args.new_string === "string" ? args.new_string : undefined,
    };
    if (rec.newString === undefined && rec.oldString === undefined && typeof args.content === "string") {
      rec.newString = args.content; // write tool: reverse -> empty (creation)
      rec.oldString = "";
    }
    const cur = this.currentTurnEdits();
    const existing = cur.edits.findIndex((e) => e.callId === callId);
    if (existing >= 0) cur.edits[existing] = rec;
    else cur.edits.push(rec);
    const uri = this.uriFor(cur, rec);
    this.latestByCall.set(callId, { uri, turn: cur.turn });
    this.emitter.fire(uri);
  }

  /** Open a VSCode native diff for one edit call. */
  async openForCall(callId: string): Promise<boolean> {
    const hit = this.latestByCall.get(callId);
    if (!hit) return false;
    await this.openUri(hit.uri);
    return true;
  }

  /** Quick pick of the current turn's changed files, then open the last diff for the picked file. */
  async openTurnSummary(): Promise<void> {
    const cur = this.currentTurnEdits();
    const files = new Map<string, number>();
    for (const e of cur.edits) files.set(e.filePath, (files.get(e.filePath) ?? 0) + 1);
    if (files.size === 0) {
      vscode.window.showInformationMessage("DSH: 当前轮没有文件编辑。");
      return;
    }
    const picks = [...files.entries()].map(([p, n]) => ({
      label: vscode.workspace.asRelativePath(p),
      description: `${n} 处编辑`,
      full: p,
    }));
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: "DSH: 本轮变更文件" });
    if (!pick) return;
    const lastEdit = [...cur.edits].reverse().find((e) => e.filePath === pick.full);
    if (lastEdit) {
      const uri = this.latestByCall.get(lastEdit.callId)?.uri ?? this.uriFor(cur, lastEdit);
      await this.openUri(uri);
    }
  }

  private async openUri(uri: vscode.Uri): Promise<void> {
    const fsPath = normalizeFs(decodeURIComponent(uri.path.replace(/^\//, "")));
    const turnNo = Number(new URLSearchParams(uri.query).get("turn") ?? "0");
    const turn = [...this.turns].reverse().find((t) => t.turn === turnNo);
    const edits = (turn?.edits ?? []).filter((e) => normalizeFs(e.filePath) === fsPath);
    let partial = false;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      partial = reconstruct(doc.getText(), edits).partial;
    } catch {
      partial = true;
    }
    const right = vscode.Uri.file(fsPath);
    const rel = vscode.workspace.asRelativePath(right);
    const title = partial ? `DSH 变更 · ${rel}（原文部分不可精确重建）` : `DSH 变更 · ${rel}`;
    await vscode.commands.executeCommand("vscode.diff", uri, right, title, { preview: false });
  }

  private currentTurnEdits(): TurnEdits {
    let cur = this.turns[this.turns.length - 1];
    if (!cur) {
      this.turnCounter += 1;
      cur = { turn: this.turnCounter, edits: [] };
      this.turns.push(cur);
    }
    return cur;
  }

  private uriFor(turn: TurnEdits, rec: EditRecord): vscode.Uri {
    const seq = turn.edits.length + 1;
    return vscode.Uri.parse(`dshdiff:/${encodePath(rec.filePath)}?v=${seq}&turn=${turn.turn}`);
  }

  private async content(uri: vscode.Uri): Promise<string> {
    const fsPath = normalizeFs(decodeURIComponent(uri.path.replace(/^\//, "")));
    const turnNo = Number(new URLSearchParams(uri.query).get("turn") ?? "0");
    const turn = [...this.turns].reverse().find((t) => t.turn === turnNo);
    const edits = (turn?.edits ?? []).filter((e) => normalizeFs(e.filePath) === fsPath);
    let current: string;
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
      current = doc.getText();
    } catch {
      // File deleted since: use the last edit's new_string as the reversal base.
      const last = edits[edits.length - 1];
      current = last?.newString ?? "";
    }
    const out = reconstruct(current, edits);
    if (out.partial) {
      for (const callId of out.misses) log(`[diff] reverse-apply miss for ${fsPath} (call ${callId}) — skipped`);
    }
    return out.content;
  }
}
