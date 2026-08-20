/**
 * Context attach: turn the editor selection (or the active file) into REAL
 * prompt content parts — never a bare "@path" string (dsh-vsc's fatal flaw).
 */
import * as vscode from "vscode";

const MAX_CHARS = 20_000;

export interface AttachResult {
  label: string;
  text: string;
}

/** Selection wins; falls back to the whole active file. Null when nothing to attach. */
export function collectAttachment(): AttachResult | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const doc = editor.document;
  const rel = vscode.workspace.asRelativePath(doc.uri);
  const sel = editor.selection;
  if (!sel.isEmpty) {
    const text = doc.getText(sel);
    if (!text.trim()) return undefined;
    const lines = sel.end.line - sel.start.line + 1;
    return {
      label: `${rel} 选区 ${lines} 行`,
      text: truncate(`[引用文件 ${rel} 选区 L${sel.start.line + 1}-L${sel.end.line + 1}]\n${text}`),
    };
  }
  const text = doc.getText();
  if (!text.trim()) return undefined;
  return {
    label: `${rel} 全文`,
    text: truncate(`[引用文件 ${rel}]\n${text}`),
  };
}

function truncate(s: string): string {
  return s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n…（已截断至 ${MAX_CHARS} 字符）` : s;
}
