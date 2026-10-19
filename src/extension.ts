import * as vscode from "vscode";
import { DshLifecycle, type ConnState } from "./connection/lifecycle.js";
import {
  DEFAULT_BASE_URL,
  LOCAL_WEB_PORT,
  candidateInstances,
  describeInstance,
  desktopAppExeResolved,
  lastDesktopDiscoveryNote,
  resolveInstance,
  waitForDesktopInstance,
  type DshInstance,
} from "./connection/instances.js";
import { SessionManager } from "./session/manager.js";
import { locateDshBin } from "./connection/locate.js";
import { DshChatView } from "./ui/panel.js";
import { DiffService } from "./diff/provider.js";
import { IdeBridge } from "./ide/bridge.js";
import { searchWorkspaceFiles } from "./context/files.js";
import { parsePinnedModel } from "./session/model-choice.js";
import { getLog, log, warn } from "./log.js";
import type { ViewToExt } from "../webview/src/protocol.js";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const panel = new DshChatView(context);
  const diff = new DiffService();
  const ideBridge = new IdeBridge();
  ideBridge.start(String(context.extension.packageJSON.version ?? ""));

  // ---- instance generation -------------------------------------------------
  // DshLifecycle / RpcClient / Auth all fix baseUrl at construction and keep
  // instance-scoped caches (auth cookie per authority, history cursor, seen
  // approval cards). Switching instances therefore REBUILDS this trio instead of
  // patching baseUrl in place (design.md §3.5).
  let lifecycle!: DshLifecycle;
  let manager!: SessionManager;
  let currentInstance: DshInstance | undefined;
  let baseUrl = DEFAULT_BASE_URL;
  /** User explicitly pinned dsh-vscode.baseUrl → never second-guess it. */
  let pinned = false;
  let instanceSubs: vscode.Disposable[] = [];
  /** While a server is being started/opened, suppress the "no instance" offer
   *  (its own probe fails by definition, which would re-prompt in a loop). */
  let offerSuppressedUntil = 0;
  let reconnectSeq = 0;
  /** Disconnected watchdog: the desktop App assigns a fresh port on every launch
   *  (DSH 0.2.1+), so a dead generation must re-resolve instead of polling one
   *  frozen baseUrl forever. Backs off 5s → 30s while nothing answers, and is
   *  cleared on connected / dispose / pinned. */
  let rediscoverTimer: NodeJS.Timeout | undefined;
  let rediscovering = false;
  let rediscoverDelayMs = 5000;
  /** True while "打开桌面版" owns the discovery (waitForDesktopInstance). The
   *  watchdog must not wire a second generation in that window. */
  let acquiring = false;

  context.subscriptions.push(panel, diff, ideBridge);
  context.subscriptions.push({
    dispose: () => {
      stopRediscovery();
      for (const d of instanceSubs) d.dispose();
      instanceSubs = [];
      lifecycle?.dispose();
    },
  });

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
  /** The status bar must always answer "which DSH am I talking to?" — including
   *  the profile's permission preset, because attaching to the desktop profile
   *  (danger-full-access) means approval cards never appear. */
  function tooltipFor(state: ConnState): string {
    const where = currentInstance ? describeInstance(currentInstance) : baseUrl;
    const head =
      state === "connected"
        ? `connected — ${where}`
        : state === "starting"
          ? `starting… (${where})`
          : state === "connecting"
            ? `connecting… (${where})`
            : `disconnected — ${where}（点这里打开面板，或运行 “DSH: Select DSH Instance”）`;
    const preset = currentInstance?.permissionPreset;
    const note = preset && /danger|full-access/i.test(preset) ? `\n注意：当前实例权限预设为 ${preset}，从插件发起的命令不会弹审批卡。` : "";
    return `DSH: ${head}${note}`;
  }

  /** 设置域「人话四条」的数据源：扩展侧偏好（VSCode 配置）+ 当前实例。
   *  与服务器 settings/describe 严格分开 —— 前者改插件行为，后者改 DSH 本体。 */
  function postPrefs(): void {
    const cfg = vscode.workspace.getConfiguration("dsh-vscode");
    panel.post({
      t: "prefs",
      data: {
        defaultModel: cfg.get<string>("defaultModel", ""),
        autoStart: cfg.get<boolean>("autoStart", true),
        baseUrl,
        baseUrlPinned: pinned,
        instanceLabel: currentInstance ? describeInstance(currentInstance) : baseUrl,
      },
    });
  }

  /** 写一条插件侧偏好（设置域「常用」四条）。三条纪律：
   *  ① **作用域**：`defaultModel` 的定位是"每个项目各钉各的模型"（见 package.json
   *     描述）⇒ 写 **Workspace**（`.vscode/settings.json`），没有工作区才退 Global。
   *     写 Global 会被工作区值盖住 ⇒ 表现为"点了没反应"的假控件。
   *  ② **值校验**：`defaultModel` 必须是 `provider/model[/effort]` 且能被
   *     `parsePinnedModel` round-trip 还原（模型 id 里含 `/` 的写进去会被解析错）。
   *     空串 = 取消钉选 ⇒ 写 `undefined` 删掉该项，而不是留一个空值。
   *  ③ **失败可见**：写失败（策略锁定等）必须 notify，不许静默。 */
  async function setPref(key: "defaultModel" | "autoStart", value: string | boolean): Promise<void> {
    try {
      const cfg = vscode.workspace.getConfiguration("dsh-vscode");
      if (key === "defaultModel") {
        const raw = typeof value === "string" ? value.trim() : "";
        if (raw) {
          const parsed = parsePinnedModel(raw);
          const ok =
            !!parsed.choice &&
            `${parsed.choice.provider}/${parsed.choice.model}${parsed.choice.reasoningEffort ? `/${parsed.choice.reasoningEffort}` : ""}` === raw;
          if (!ok) {
            panel.post({ t: "notify", kind: "warn", message: `默认模型格式不支持：${raw}（应为 provider/model）` });
            return;
          }
        }
        const target = (vscode.workspace.workspaceFolders?.length ?? 0) > 0
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
        await cfg.update("defaultModel", raw || undefined, target);
      } else {
        await cfg.update("autoStart", !!value, vscode.ConfigurationTarget.Global);
      }
      postPrefs();
    } catch (err) {
      panel.post({ t: "notify", kind: "warn", message: `保存设置失败：${String(err).slice(0, 120)}` });
    }
  }

  function wireInstance(instance: DshInstance): void {
    // Idempotent: a watchdog tick and the explicit "打开桌面版" wait can race;
    // never rebuild an already-live generation for the same address.
    if (lifecycle && instance.baseUrl === baseUrl && lifecycle.currentState !== "disconnected") {
      log(`[extension] already connected to ${instance.baseUrl}; skip re-wire`);
      return;
    }
    /** Keep the user's open session across a generation rebuild (instance switch
     *  or desktop-port move). Consumed once by the new manager's first connect. */
    const restoreSession = manager?.current;
    for (const d of instanceSubs) d.dispose();
    instanceSubs = [];
    try {
      lifecycle?.dispose();
    } catch {
      /* first generation */
    }
    currentInstance = instance;
    baseUrl = instance.baseUrl;
    const generation = new DshLifecycle(baseUrl, instance.kind !== "desktop-app");
    lifecycle = generation;
    manager = new SessionManager(
      generation,
      { post: (m) => panel.post(m) },
      context.globalState,
      context.workspaceState,
      restoreSession,
    );
    manager.bindDiff(diff);

    const ev = generation.events;
    instanceSubs.push(
      ev.onState((s: ConnState) => {
        status.text = statusText[s] ?? "$(circle-slash) DSH";
        status.tooltip = tooltipFor(s);
        panel.post({ t: "conn", state: s, baseUrl });
        // Capability hint follows every connection-state change (design.md §3.6):
        // legacy hosts have no pin/unpin/unarchive endpoints.
        panel.post({ t: "caps", flavor: generation.currentFlavor ?? "legacy" });
        postPrefs();
        // The desktop port changes on every App launch (DSH 0.2.1+): while the
        // current generation is dead, look for a new address; stop once hooked.
        if (s === "connected") stopRediscovery();
        else if (s === "disconnected") scheduleRediscovery();
      }),
      // Connection problems that need the user's eyes (v012 auth, unknown protocol).
      ev.onProblem((message: string) => {
        panel.post({ t: "notify", kind: "warn", message });
        void vscode.window.showWarningMessage(message);
      }),
      ev.onNeedsInstance(() => {
        if (Date.now() < offerSuppressedUntil) return;
        void offerInstance();
      }),
    );
    status.text = statusText.connecting;
    status.tooltip = tooltipFor("connecting");
    status.show();
    panel.post({ t: "conn", state: "connecting" });
    log(
      `[extension] instance: ${instance.label} → ${instance.baseUrl} ` +
        `(profile ${instance.profile ?? "?"}, ${instance.running ? "running" : "down"})`,
    );
    void generation.init();
  }

  /** Nothing answered: offer the preferred fallback (open the desktop App) and
   *  keep "start a legacy local server" available but clearly secondary. */
  async function offerInstance(): Promise<void> {
    if (pinned) {
      const pick = await vscode.window.showWarningMessage(
        `DSH: 自定义地址 ${baseUrl} 没有响应。`,
        "重试",
        "选择实例…",
        "改用自动发现",
      );
      if (pick === "重试") void lifecycle.init();
      else if (pick === "选择实例…") void pickInstance();
      else if (pick === "改用自动发现") {
        // Only the user may drop the escape hatch; the config event reconnects.
        await clearBaseUrlScopes();
      }
      return;
    }
    const appPath = await desktopAppExeResolved();
    if (!vscode.workspace.getConfiguration("dsh-vscode").get<boolean>("autoStart", true)) {
      status.tooltip = tooltipFor("disconnected");
      return;
    }
    // 2026-09-30: the user deleted their legacy CLI, so do not promise a launch
    // we cannot perform — offer the old-CLI action only when the CLI actually
    // resolves (the code path itself is kept: reinstalling restores it).
    const haveLegacyCli = !!locateDshBin({
      explicit: vscode.workspace.getConfiguration("dsh-vscode").get<string>("dshBinPath", ""),
      home,
    }).hit;
    const buttons = [
      ...(appPath ? ["打开桌面版"] : []),
      "选择实例…",
      "手动输入地址…",
      ...(haveLegacyCli ? ["启动本地 dsh web（旧版）"] : []),
    ];
    const discoveryNote = lastDesktopDiscoveryNote();
    const pick = await vscode.window.showWarningMessage(
      `DSH: 没有检测到运行中的实例（桌面版${haveLegacyCli ? ` 与旧版 ${LOCAL_WEB_PORT}` : ""} 都没有响应）。` +
        (appPath ? "可以打开桌面版 App —— 功能最全，且与 GUI 共享会话。" : "") +
        (discoveryNote ? `（${discoveryNote}，可用“手动输入地址…”）` : "") +
        (haveLegacyCli ? "" : "（本机未检测到旧版 dsh CLI，已隐藏“启动旧版”入口。）"),
      ...buttons,
    );
    if (pick === "打开桌面版" && appPath) {
      offerSuppressedUntil = Date.now() + 90_000;
      status.text = statusText.starting;
      status.tooltip = tooltipFor("starting");
      acquiring = true;
      // The App's gateway port is assigned by the OS at launch (DSH 0.2.1+), so
      // wait for discovery instead of polling one fixed address. `acquiring`
      // keeps the watchdog from wiring a second generation in this window.
      try {
        const attached = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "DSH: 正在启动桌面版并等待本地端口…" },
          () => waitForDesktopInstance(appPath, { home }),
        );
        if (attached) {
          wireInstance(attached);
        } else {
          status.text = statusText.disconnected;
          status.tooltip = tooltipFor("disconnected");
          void vscode.window.showErrorMessage(
            "DSH: 已启动桌面版，但 60s 内没有发现它的本地端口，可查看日志或用 “DSH: Select DSH Instance”。",
          );
        }
      } finally {
        acquiring = false;
      }
      scheduleRediscovery(); // keep looking (no-op when connected)
      return;
    }
    if (pick === "选择实例…") {
      void pickInstance();
      return;
    }
    if (pick === "手动输入地址…") {
      void manualAddress();
      return;
    }
    if (pick === "启动本地 dsh web（旧版）") {
      // Retarget to 3080 FIRST: startDsh() starts whatever port THIS lifecycle
      // points at, and the current generation may point at a dead desktop port.
      const legacy = candidateInstances(appPath).find((c) => c.kind === "local-web");
      offerSuppressedUntil = Date.now() + 130_000; // the readiness poll window
      if (legacy) wireInstance(legacy);
      await lifecycle.startDsh();
    }
  }

  /** Drop a pinned baseUrl at EVERY settings scope. Writing only Global is a
   *  no-op when a workspace/folder value shadows it (the same trap the
   *  defaultModel control hit in 0.21.1). */
  async function clearBaseUrlScopes(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("dsh-vscode");
    const info = cfg.inspect<string>("baseUrl");
    if (info?.workspaceFolderValue !== undefined) {
      await cfg.update("baseUrl", undefined, vscode.ConfigurationTarget.WorkspaceFolder);
    }
    if (info?.workspaceValue !== undefined) {
      await cfg.update("baseUrl", undefined, vscode.ConfigurationTarget.Workspace);
    }
    if (info?.globalValue !== undefined) {
      await cfg.update("baseUrl", undefined, vscode.ConfigurationTarget.Global);
    }
  }

  /** Manual escape hatch: pin any address by hand (the only way out if port
   *  discovery is blocked by policy and the App is running on an unknown port). */
  async function manualAddress(): Promise<void> {
    const input = await vscode.window.showInputBox({
      title: "DSH: 手动输入实例地址",
      prompt: "例如 http://127.0.0.1:59204（状态条 tooltip 或面板里也显示当前地址）",
      value: baseUrl.startsWith(DEFAULT_BASE_URL) ? "" : baseUrl,
      validateInput: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? undefined : "需以 http:// 或 https:// 开头"),
    });
    if (!input) return;
    const url = input.trim().replace(/\/+$/, "");
    log(`[extension] manual instance address: ${url}`);
    // The config event reconnects; no explicit reconnect call needed.
    await vscode.workspace.getConfiguration("dsh-vscode").update("baseUrl", url, vscode.ConfigurationTarget.Global);
  }

  /** Quick pick of every known instance (live state probed now) + auto mode. */
  async function pickInstance(): Promise<void> {
    const appPath = await desktopAppExeResolved();
    const resolution = await resolveInstance({ home, explicitBaseUrl: "", appExe: () => appPath });
    type Item = vscode.QuickPickItem & { auto?: boolean; instance?: DshInstance; manual?: boolean };
    const items: Item[] = [
      {
        label: "$(sync) 自动选择",
        description: `优先桌面版（运行时发现端口），其次旧版 ${LOCAL_WEB_PORT}`,
        detail: "未手动指定 baseUrl 时生效（推荐）",
        auto: true,
      },
      ...resolution.candidates.map((c) => ({
        label: `${c.running ? "$(pass-filled)" : "$(circle-slash)"} ${c.label}`,
        description: describeInstance(c),
        detail: c.running
          ? c.kind === "desktop-app" && c.id !== "desktop-app"
            ? "运行中 —— 端口每次启动会变，选中=回到自动选择"
            : "运行中"
          : c.kind === "desktop-app"
            ? "未运行 —— 选中后可打开桌面版 App"
            : "未运行",
        instance: c,
      })),
      {
        label: "$(edit) 手动输入地址…",
        description: "端口自动发现被策略禁止时用",
        detail: "写回 dsh-vscode.baseUrl（固定地址，不再自动发现）",
        manual: true,
      },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: "DSH: 选择要连接的实例（自动选择会写回默认 baseUrl）",
      matchOnDescription: true,
      matchOnDetail: true,
    });
    if (!pick) return;
    if (pick.manual) {
      await manualAddress();
      return;
    }
    // A discovered (dynamic) desktop port must NOT be pinned: it dies with the
    // App's next launch. Selecting it means "stay on auto", which rediscovers.
    const dynamicDesktop = !!pick.instance && pick.instance.kind === "desktop-app" && pick.instance.id !== "desktop-app";
    if (dynamicDesktop) {
      log(`[extension] dynamic desktop port ${pick.instance?.baseUrl} selected → staying in auto mode`);
      void vscode.window.showInformationMessage("DSH: 桌面版端口每次启动会变，已保持自动选择（不钉死地址）。");
    }
    const target = pick.auto || dynamicDesktop ? undefined : pick.instance?.baseUrl;
    const cfg = vscode.workspace.getConfiguration("dsh-vscode");
    const before = cfg.get<string>("baseUrl", DEFAULT_BASE_URL);
    if (target === undefined) await clearBaseUrlScopes();
    else await cfg.update("baseUrl", target, vscode.ConfigurationTarget.Global);
    // A config event reconnects when the effective value changed; when it did
    // not (e.g. "自动选择" was already active) reconnect manually.
    if (cfg.get<string>("baseUrl", DEFAULT_BASE_URL) === before) void reconnect();
  }

  /** Resolve the instance (explicit baseUrl wins, else probe desktop → legacy)
   *  and rebuild the generation against it. */
  async function reconnect(): Promise<void> {
    const seq = ++reconnectSeq;
    const explicit = vscode.workspace.getConfiguration("dsh-vscode").get<string>("baseUrl", DEFAULT_BASE_URL);
    const resolution = await resolveInstance({ home, explicitBaseUrl: explicit });
    if (seq !== reconnectSeq) return; // superseded by a newer request
    pinned = resolution.pinned;
    const target = resolution.instance ?? resolution.candidates[0];
    if (!target) {
      warn("[extension] no candidates at all — cannot connect");
      return;
    }
    if (!resolution.instance) {
      log(`[extension] nothing running; falling back to ${target.label} (${target.baseUrl})`);
    }
    wireInstance(target);
  }

  /** Stop the disconnected watchdog (connected / dispose). */
  function stopRediscovery(): void {
    if (rediscoverTimer) {
      clearTimeout(rediscoverTimer);
      rediscoverTimer = undefined;
    }
    rediscoverDelayMs = 5000;
  }

  /** Schedule the next re-resolve. Cheap by contract: one discovery per attempt,
   *  exponential backoff (5s → 30s) so a long-stopped App does not keep a
   *  PowerShell scan running every few seconds. Skipped while pinned (the escape
   *  hatch must never be second-guessed). */
  function scheduleRediscovery(delayMs = rediscoverDelayMs): void {
    if (rediscoverTimer || pinned || acquiring) return;
    // autoStart=false means "do not hunt for an instance"; respect it here too.
    if (!vscode.workspace.getConfiguration("dsh-vscode").get<boolean>("autoStart", true)) return;
    rediscoverTimer = setTimeout(() => {
      rediscoverTimer = undefined;
      void rediscoverTick();
    }, delayMs);
  }

  /** Re-resolve the instance while disconnected; rewire only on a NEW address. */
  async function rediscoverTick(): Promise<void> {
    if (rediscovering || acquiring || pinned || !lifecycle || lifecycle.currentState !== "disconnected") return;
    rediscovering = true;
    try {
      const resolution = await resolveInstance({ home, explicitBaseUrl: "" });
      const found = resolution.instance;
      if (found && found.baseUrl !== baseUrl) {
        log(`[extension] instance moved to ${found.baseUrl}; re-wiring`);
        stopRediscovery();
        wireInstance(found);
        return;
      }
    } catch (err) {
      warn(`[extension] rediscovery failed: ${String(err)}`);
    } finally {
      rediscovering = false;
    }
    scheduleRediscovery((rediscoverDelayMs = Math.min(rediscoverDelayMs * 2, 30_000)));
  }

  // Wire webview -> manager.
  panel.onMessage(async (m: ViewToExt) => {
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
      case "fork-at":
        void manager.forkSessionAt(m.sessionId, m.atSeq);
        break;
      case "open-file":
        void openFileInEditor(m.path);
        break;
      case "open-browser":
        void vscode.env.openExternal(vscode.Uri.parse(baseUrl));
        break;
      case "feedback":
        log(`[feedback] ${m.sessionId} ${m.kind}${m.comment ? `: ${m.comment}` : ""}`);
        break;
      case "pick-file":
        void pickPaths({ canSelectMany: true, openLabel: "添加文件" }).then((items) => panel.post({ t: "picked", reqId: m.reqId, items }));
        break;
      case "pick-folder":
        void pickPaths({ canSelectFolders: true, canSelectMany: true, openLabel: "添加文件夹" }).then((items) => panel.post({ t: "picked", reqId: m.reqId, items }));
        break;
      case "open-settings":
        void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:wurui.dsh-web-vscode");
        break;
      case "list-subagents":
        void manager.listSubagents(m.sessionId);
        break;
      case "subagent-history":
        void manager.subagentHistory(m.childId);
        break;
      case "subagent-prompt":
        void manager.subagentPrompt(m.childId, m.text);
        break;
      case "subagent-interrupt":
        void manager.subagentInterrupt(m.childId);
        break;
      case "get-settings":
        void manager.describeSettings();
        break;
      case "save-setting":
        void manager.saveSetting(m.ns, m.patch, m.revision);
        break;
      // 设置域「人话四条」：扩展侧偏好的写入 + 实例切换命令（不碰服务器协议）
      case "get-prefs":
        postPrefs();
        break;
      case "set-pref":
        await setPref(m.key, m.value);
        break;
      case "select-instance":
        void pickInstance();
        break;
      case "list-workspaces":
        void manager.listWorkspaces();
        break;
      case "workspace-rename":
        void manager.workspaceRename(m.workspaceId, m.title);
        break;
      case "workspace-move":
        void manager.workspaceMove(m.workspaceId, m.beforeWorkspaceId);
        break;
      case "workspace-delete":
        void manager.workspaceDelete(m.workspaceId);
        break;
      case "workspace-add": {
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectMany: false, openLabel: "添加为工作区" });
        if (picked && picked.length > 0) void manager.workspaceCreate(picked[0].fsPath);
        break;
      }
      case "workspace-move-session":
        void manager.workspaceMoveSession(m.sessionId, m.toWorkspaceId);
        break;
      case "archive-session":
        void manager.archiveSession(m.sessionId);
        break;
      case "pin-session":
        void manager.setPinned(m.sessionId, m.pinned);
        break;
      case "unarchive-session":
        void manager.unarchiveSession(m.sessionId);
        break;
      case "search-sessions":
        manager.searchSessions(m.reqId, m.query);
        break;
      case "goal-action":
        void manager.goalAction(m.action, m.ref);
        break;
      case "goal-create":
        void manager.createGoal(m.objective);
        break;
      case "kill-job":
        void manager.killJob(m.jobId);
        break;
      case "list-schedules":
        void manager.listSchedules();
        break;
      case "delete-schedule":
        void manager.deleteSchedule(m.id);
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
      case "queue-edit":
        void manager.queueEdit(m.sessionId, m.itemId, m.text);
        break;
      case "queue-steer":
        void manager.queueSteer(m.sessionId, m.itemId);
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
      case "get-attachment":
        void manager.getAttachment(m.sessionId, m.attachmentId);
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
    vscode.commands.registerCommand("dsh-vscode.showSessionChanges", () => {
      void diff.openSessionSummary();
    }),
    // Cross-workspace session search (design.md §3.6): the panel owns the UI,
    // the host filters on demand — `session/search` is disabled on this
    // deployment, and enabling it is a DSH config change (red line).
    vscode.commands.registerCommand("dsh-vscode.searchSessions", () => {
      panel.reveal();
      panel.post({ t: "open-search" });
    }),
    vscode.commands.registerCommand("dsh-vscode.showLogs", () => getLog().show()),
    // Which DSH are we talking to? (desktop App on 19387 / legacy CLI on 3080)
    vscode.commands.registerCommand("dsh-vscode.selectInstance", () => void pickInstance()),
    // Proactive half of the auto-start path fix (0.18.5): pick node.exe / the dsh
    // CLI by hand without waiting for a failed start. Empty settings = auto-detect.
    vscode.commands.registerCommand("dsh-vscode.locateDsh", async () => {
      const items: Array<vscode.QuickPickItem & { target: "node" | "dsh" }> = [
        { label: "dsh CLI 入口（lib/bin.js）", detail: "拉起 dsh web 时执行的文件", target: "dsh" },
        { label: "node.exe", detail: "运行 dsh CLI 的可执行文件", target: "node" },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: "DSH: 手动指定路径（设置留空则自动探测）" });
      if (pick) await lifecycle.pickExe(pick.target);
    }),
    // Instance switching is stored in dsh-vscode.baseUrl: every VSCode window
    // gets this event, so all windows converge on one instance (and Auth is keyed
    // by authority, so a switch cannot leak the previous cookie).
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dsh-vscode.defaultModel") || e.affectsConfiguration("dsh-vscode.autoStart")) {
        postPrefs(); // 设置域里改的值立刻回显（也可能来自 VSCode 设置页）
      }
      if (!e.affectsConfiguration("dsh-vscode.baseUrl")) return;
      setTimeout(() => void reconnect(), 250);
    }),
  ];
  context.subscriptions.push(...subs);

  await reconnect();
}

export function deactivate(): void {
  /* disposal via context.subscriptions */
}

/** Open a produced file in the editor (files-card click). Relative paths
 *  resolve against the first workspace folder. */
async function openFileInEditor(path: string): Promise<void> {
  try {
    const { Uri, workspace, window } = vscode;
    const isAbs = /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
    let uri = Uri.file(path);
    if (!isAbs) {
      const root = workspace.workspaceFolders?.[0]?.uri;
      if (!root) return;
      uri = Uri.joinPath(root, path);
    }
    const doc = await workspace.openTextDocument(uri);
    await window.showTextDocument(doc, { preview: true });
  } catch (err) {
    void vscode.window.showWarningMessage(`DSH: 无法打开文件 ${path}（${String(err).slice(0, 80)}）`);
  }
}

/** Native file/folder picker for the composer ＋ menu; returns {path, rel}
 *  pairs (rel = workspace-root-relative when possible). */
async function pickPaths(opts: { canSelectMany?: boolean; canSelectFolders?: boolean; openLabel: string }): Promise<{ path: string; rel: string }[]> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: !opts.canSelectFolders,
    canSelectFolders: opts.canSelectFolders ?? false,
    canSelectMany: opts.canSelectMany ?? false,
    openLabel: opts.openLabel,
    defaultUri: root ? vscode.Uri.file(root) : undefined,
  });
  return (picked ?? []).map((uri) => ({
    path: uri.fsPath,
    rel: root && uri.fsPath.toLowerCase().startsWith(root.toLowerCase())
      ? uri.fsPath.slice(root.length).replace(/^[\\/]+/, "")
      : uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath,
  }));
}
