/**
 * IDE bridge server: a loopback HTTP endpoint inside the extension host that
 * the dsh-ide-bridge plugin (agent tools) calls to read VSCode state —
 * active file, selection, diagnostics — and to open/reveal files.
 *
 * Discovery + auth: writes ~/.dsh/dsh-vscode-ide.json ({port, token, pid})
 * once listening; deletes it on dispose (only if this instance wrote it).
 * Another VSCode window already serving keeps its file (EADDRINUSE -> skip).
 */
import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import { log, warn } from "../log.js";

const PORT = 3187;
const DISCOVERY_FILE = path.join(os.homedir(), ".dsh", "dsh-vscode-ide.json");
const BODY_LIMIT = 1024 * 512;

const SEVERITIES = ["error", "warning", "information", "hint"] as const;
type Severity = (typeof SEVERITIES)[number];

interface BridgeRequest {
  file?: string;
  severities?: string[];
  max?: number;
  line?: number;
  column?: number;
  takeFocus?: boolean;
}

export class IdeBridge implements vscode.Disposable {
  private server?: http.Server;
  private token?: string;
  private wroteDiscovery = false;

  start(version: string): void {
    const token = crypto.randomBytes(24).toString("hex");
    const server = http.createServer((req, res) => void this.dispatch(req, res));
    server.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        log("[ide-bridge] port 3187 busy — another window is serving; bridge passive here");
        return;
      }
      warn(`[ide-bridge] server error: ${String(err)}`);
    });
    server.listen(PORT, "127.0.0.1", () => {
      this.token = token;
      this.server = server;
      try {
        fs.writeFileSync(DISCOVERY_FILE, JSON.stringify({ port: PORT, token, pid: process.pid, version }, null, 2));
        this.wroteDiscovery = true;
        log(`[ide-bridge] listening on 127.0.0.1:${PORT} (discovery file written)`);
      } catch (err) {
        warn(`[ide-bridge] discovery file write failed: ${String(err)}`);
      }
    });
  }

  dispose(): void {
    if (this.server) this.server.close();
    if (this.wroteDiscovery) {
      try {
        fs.rmSync(DISCOVERY_FILE, { force: true });
      } catch {
        /* best effort */
      }
    }
  }

  // ---- request plumbing ----

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    };
    try {
      if (!this.token || req.headers.authorization !== `Bearer ${this.token}`) {
        send(401, { error: "unauthorized" });
        return;
      }
      if (req.method !== "POST") {
        send(405, { error: "method not allowed" });
        return;
      }
      const body = await readBody(req);
      switch (req.url) {
        case "/ping":
          send(200, { ok: true, bridge: "dsh-web-vscode" });
          return;
        case "/active-file":
          send(200, this.activeFile());
          return;
        case "/selection":
          send(200, this.selection());
          return;
        case "/diagnostics":
          send(200, this.diagnostics(body));
          return;
        case "/open-file":
          send(200, await this.openFile(body));
          return;
        default:
          send(404, { error: `unknown route ${req.url}` });
      }
    } catch (err) {
      send(500, { error: String(err instanceof Error ? err.message : err) });
    }
  }

  // ---- capability bodies ----

  private activeFile() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return { active: false };
    const pos = ed.selection.active;
    return {
      active: true,
      file: ed.document.fileName,
      language: ed.document.languageId,
      lineCount: ed.document.lineCount,
      cursorLine: pos.line + 1,
      cursorColumn: pos.character + 1,
    };
  }

  private selection() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return { hasSelection: false };
    const sel = ed.selection;
    const base = {
      file: ed.document.fileName,
      language: ed.document.languageId,
    };
    if (sel.isEmpty) {
      return { hasSelection: false, ...base, cursorLine: sel.active.line + 1, cursorColumn: sel.active.character + 1 };
    }
    const text = ed.document.getText(sel);
    return {
      hasSelection: true,
      ...base,
      text,
      startLine: sel.start.line + 1,
      endLine: sel.end.line + 1,
    };
  }

  private diagnostics(body: BridgeRequest) {
    const want = new Set<Severity>(
      (body.severities ?? ["error", "warning"]).filter((s): s is Severity =>
        (SEVERITIES as readonly string[]).includes(s),
      ),
    );
    const max = Math.max(1, Math.min(body.max ?? 50, 200));
    // Normalize the filter through Uri.file(): the diagnostics table is keyed
    // by canonical VSCode uris — raw Windows paths (lowercase drive letter,
    // mixed slashes) miss otherwise. Compare on uri.toString().
    const filterUri = body.file ? vscode.Uri.file(body.file) : undefined;
    const fileMatch = (uri: vscode.Uri): boolean =>
      filterUri === undefined || uri.toString() === filterUri.toString();
    const entries: unknown[] = [];
    let total = 0;
    const push = (file: string, uri: vscode.Uri, d: vscode.Diagnostic): void => {
      const sev = SEVERITIES[d.severity] ?? "warning";
      if (!want.has(sev) || !fileMatch(uri)) return;
      total += 1;
      if (entries.length >= max) return;
      entries.push({
        file,
        severity: sev,
        message: d.message,
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        source: d.source,
        code: typeof d.code === "object" && d.code ? String(d.code.value) : d.code,
      });
    };
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      for (const d of diags) push(uri.fsPath, uri, d);
    }
    return { total, truncated: total > entries.length, entries };
  }

  private async openFile(body: BridgeRequest) {
    if (!body.file || !path.isAbsolute(body.file)) {
      throw new Error("file (absolute path) is required");
    }
    if (!fs.existsSync(body.file)) throw new Error(`file not found: ${body.file}`);
    const uri = vscode.Uri.file(body.file);
    const line = body.line !== undefined ? Math.max(1, Math.floor(body.line)) : undefined;
    const col = body.column !== undefined ? Math.max(1, Math.floor(body.column)) : undefined;
    const options: vscode.TextDocumentShowOptions = {
      preserveFocus: body.takeFocus === false,
      ...(line !== undefined
        ? {
            selection: new vscode.Range(
              line - 1,
              col !== undefined ? col - 1 : 0,
              line - 1,
              col !== undefined ? col + 80 : 1000,
            ),
          }
        : {}),
    };
    await vscode.window.showTextDocument(uri, options);
    return { opened: true, file: body.file, ...(line !== undefined ? { revealedLine: line } : {}) };
  }
}

function readBody(req: http.IncomingMessage): Promise<BridgeRequest> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new Error(`bad json body: ${String(err)}`));
      }
    });
    req.on("error", reject);
  });
}
