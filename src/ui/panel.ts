/**
 * Webview view provider: loads the built webview bundle, owns the postMessage
 * route to/from the SessionManager, and re-injects state when the webview
 * reloads (webview can sleep; extension host state survives).
 */
import * as vscode from "vscode";
import type { ExtToView, ViewToExt } from "../../webview/src/protocol.js";
import { log } from "../log.js";

export class DshChatView implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = "dsh-vscode.chat";
  private view: vscode.WebviewView | undefined;
  private queueWhileAsleep: ExtToView[] = [];
  private readonly emitter = new vscode.EventEmitter<ViewToExt>();
  readonly onMessage = this.emitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: ViewToExt) => {
      if (m?.t === "ready") {
        this.queueWhileAsleep = [];
        log("[panel] webview ready");
      }
      this.emitter.fire(m);
    });
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  post(msg: ExtToView): void {
    if (this.view) {
      void this.view.webview.postMessage(msg);
    } else if (this.queueWhileAsleep.length < 200) {
      this.queueWhileAsleep.push(msg);
    }
  }

  /** Called when the webview reports ready: flush anything parked. */
  flushParked(): void {
    for (const m of this.queueWhileAsleep.splice(0)) this.post(m);
  }

  reveal(): void {
    if (this.view) this.view.show?.(true);
    else void vscode.commands.executeCommand(`${DshChatView.viewId}.focus`);
  }

  dispose(): void {
    this.emitter.dispose();
  }

  private html(webview: vscode.Webview): string {
    const js = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview.js"));
    const nonce = Math.random().toString(36).slice(2);
    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource} 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  #root { height: 100%; }
</style>
</head>
<body>
<div id="root"></div>
<pre id="booterr" style="display:none;color:#f14c4c;font:12px monospace;padding:8px;margin:0;white-space:pre-wrap;word-break:break-all;"></pre>
<script nonce="${nonce}">
(function(){
  function show(msg){
    var el = document.getElementById('booterr');
    if (el) { el.textContent += msg + "\\n"; el.style.display = "block"; }
    try { (window.__dshApi = window.__dshApi || acquireVsCodeApi()).postMessage({ t: "log", message: "[boot] " + msg }); } catch (e) {}
  }
  window.addEventListener("error", function(e){ show(e.message + (e.filename ? " @" + e.filename.split("/").pop() + ":" + e.lineno : "")); });
  window.addEventListener("unhandledrejection", function(e){ show("promise: " + ((e.reason && e.reason.message) || e.reason)); });
  setTimeout(function(){
    var r = document.getElementById("root");
    if (!r || !r.hasChildNodes()) show("webview 3 秒内未渲染任何内容（bundle 未执行或渲染崩溃）");
  }, 3000);
})();
</script>
<script nonce="${nonce}" type="module" src="${js}"></script>
</body>
</html>`;
  }
}
