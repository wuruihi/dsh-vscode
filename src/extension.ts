import * as vscode from "vscode";
import { DshLifecycle } from "./connection/lifecycle.js";
import { SessionManager } from "./session/manager.js";
import { DshChatView } from "./ui/panel.js";
import { DiffService } from "./diff/provider.js";
import { IdeBridge } from "./ide/bridge.js";
import { searchWorkspaceFiles } from "./context/files.js";
import { getLog, log } from "./log.js";
import type { ViewToExt } from "../webview/src/protocol.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("dsh-vscode");
  const baseUrl = cfg.get<string>("baseUrl", "http://127.0.0.1:3080");

  const lifecycle = new DshLifecycle(baseUrl);
  const panel = new DshChatView(context);
  const manager = new SessionManager(lifecycle, { post: (m) => panel.post(m) }, context.globalState);
  const diff = new DiffService();
  manager.bindDiff(diff);
  const ideBridge = new IdeBridge();
  ideBridge.start(String(context.extension.packageJSON.version ?? ""));

  context.subscriptions.push(lifecycle, panel, diff, ideBridge);

  // Webview provider registration.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshChatView.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }),
  );

  // Status bar.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = "dsh-vscode.focus";
  status.name = "DSH";
  context.subscriptions.push(status);
  const statusText: Record<string, string> = {
    connecting: "$(sync~spin) DSH",
    connected: "$(check-all) DSH",
    disconnected: "$(circle-slash) DSH",
    starting: "$(play) DSH",
  };
  const statusTooltip: Record<string, string> = {
    connecting: "DSH: connecting…",
    connected: `DSH: connected (${baseUrl})`,
    disconnected: "DSH: disconnected — click to open chat and retry",
    starting: "DSH: starting dsh web…",
  };
  lifecycle.events.onState((s) => {
    status.text = statusText[s] ?? "$(circle-slash) DSH";
    status.tooltip = statusTooltip[s] ?? s;
  });
  panel.post({ t: "conn", state: "connecting" });
  lifecycle.events.onState((s) => panel.post({ t: "conn", state: s, baseUrl }));
  status.text = statusText.connecting;
  status.show();

  // Wire webview -> manager.
  panel.onMessage((m: ViewToExt) => {
    if (m.t === "ready") {
      panel.flushParked();
      void manager.onWebviewReady();
      return;
    }
    switch (m.t) {
      case "prompt":
        void manager.prompt(m.sessionId, m.mode, m.parts);
        break;
      case "cancel":
        void manager.cancel(m.sessionId);
        break;
      case "new-session":
        void manager.newSession();
        break;
      case "switch":
        void manager.switchSession(m.sessionId);
        break;
      case "rename":
        void manager.rename(m.sessionId, m.title);
        break;
      case "fork-session":
        void manager.forkSession(m.sessionId);
        break;
      case "archive-session":
        void manager.archiveSession(m.sessionId);
        break;
      case "respond-approval":
        void manager.respondApproval(m.rpcId, m.sessionId, m.approvalId, m.outcome);
        break;
      case "respond-question":
        void manager.respondQuestion(m.rpcId, m.sessionId, m.answers);
        break;
      case "select-model":
        void manager.selectModel(m.sessionId, m.provider, m.model, m.reasoningEffort);
        break;
      case "select-preset":
        void manager.selectPreset(m.sessionId, m.agentPreset);
        break;
      case "set-session-permission":
        void manager.setSessionPermission(m.sessionId, m.preset);
        break;
      case "get-models":
        void manager.refreshModels(m.sessionId);
        break;
      case "queue-remove":
        void manager.queueRemove(m.sessionId, m.itemId);
        break;
      case "load-older":
        void manager.loadOlder(m.sessionId, m.beforeSeq);
        break;
      case "list-files":
        searchWorkspaceFiles(m.query).then((items) =>
          panel.post({ t: "files", reqId: m.reqId, items }),
        );
        break;
      case "list-slash":
        manager.listSlash(m.sessionId).then((items) =>
          panel.post({ t: "slash", reqId: m.reqId, items }),
        );
        break;
      case "run-command":
        void manager.runCommand(m.sessionId, m.line);
        break;
      case "open-diff":
        void diff.openForCall(m.callId).then((opened) => {
          if (!opened) void diff.openTurnSummary();
        });
        break;
      case "log":
        log(`[webview] ${m.message}`);
        break;
      default:
        break;
    }
  });

  // Commands.
  const subs: vscode.Disposable[] = [
    vscode.commands.registerCommand("dsh-vscode.focus", () => panel.reveal()),
    vscode.commands.registerCommand("dsh-vscode.openInEditor", () => panel.reveal()),
    vscode.commands.registerCommand("dsh-vscode.newSession", () => {
      panel.reveal();
      void manager.newSession();
    }),
    vscode.commands.registerCommand("dsh-vscode.showTurnChanges", () => {
      void diff.openTurnSummary();
    }),
    vscode.commands.registerCommand("dsh-vscode.showLogs", () => getLog().show()),
  ];
  context.subscriptions.push(...subs);

  await lifecycle.init();
}

export function deactivate(): void {
  /* disposal via context.subscriptions */
}
