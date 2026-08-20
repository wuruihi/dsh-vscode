import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function getLog(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel("DSH");
  return channel;
}

export function log(...args: unknown[]): void {
  getLog().appendLine(args.map(fmt).join(" "));
}

export function warn(...args: unknown[]): void {
  getLog().appendLine(`[warn] ${args.map(fmt).join(" ")}`);
}

export function error(...args: unknown[]): void {
  getLog().appendLine(`[error] ${args.map(fmt).join(" ")}`);
}

function fmt(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
