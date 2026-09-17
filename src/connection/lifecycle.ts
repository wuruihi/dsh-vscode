/**
 * Connection lifecycle (design.md §3.0): detect the server's protocol flavor,
 * optionally start dsh web (Windows-only detached Start-Process), own the
 * RpcClient + the flavor-matched stream layer (legacy dual-WS EventStreams or
 * v012 single remote.mux V012Streams), and publish a small state machine to
 * the UI. Repeated stream failures re-run detection so a mid-session DSH
 * upgrade is picked up without a window reload.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as vscode from "vscode";
import { RpcClient } from "./client.js";
import { EventStreams } from "./events.js";
import { V012Streams } from "./remote.js";
import { Auth } from "./auth.js";
import { detectFlavor, type Flavor } from "./protocol.js";
import {
  isDir,
  locateDshBin,
  locateNodeExe,
  looksLikeDshBin,
  looksLikeNodeExe,
  nearestExistingDir,
  type LocateOutcome,
} from "./locate.js";
import { log, warn, error } from "../log.js";

export type ConnState = "connecting" | "connected" | "disconnected" | "starting";

export interface DshServiceEvents {
  onState: vscode.Event<ConnState>;
  /** Emitted on every WS-ready generation (initial connect + reconnects). */
  onStreamsReady: vscode.Event<number>;
  onMux: vscode.Event<{ rpcId: string; payload: any }>;
  onHost: vscode.Event<{ rpcId: string; payload: any }>;
  /** Human-facing connection problem (auth missing / protocol unknown). */
  onProblem: vscode.Event<string>;
}

interface DshStreams {
  readonly generation: number;
  start(): void;
  stop(): void;
  retryNow(): void;
  follow(sessionId: string | undefined): void;
}

export class DshLifecycle {
  private state: ConnState = "connecting";
  private readonly stateEmitter = new vscode.EventEmitter<ConnState>();
  private readonly readyEmitter = new vscode.EventEmitter<number>();
  private readonly muxEmitter = new vscode.EventEmitter<{ rpcId: string; payload: any }>();
  private readonly hostEmitter = new vscode.EventEmitter<{ rpcId: string; payload: any }>();
  private readonly problemEmitter = new vscode.EventEmitter<string>();
  private probeTimer: NodeJS.Timeout | undefined;

  private streams: DshStreams | undefined;
  private flavor: Flavor | undefined;
  private consecutiveFailures = 0;
  private detecting = false;

  readonly client: RpcClient;
  readonly auth: Auth;
  private readonly home: string;

  constructor(private readonly baseUrl: string) {
    this.home = process.env.USERPROFILE ?? process.env.HOME ?? "";
    this.auth = new Auth();
    this.client = new RpcClient(baseUrl, this.auth, this.home);
  }

  get events(): DshServiceEvents {
    return {
      onState: this.stateEmitter.event,
      onStreamsReady: this.readyEmitter.event,
      onMux: this.muxEmitter.event,
      onHost: this.hostEmitter.event,
      onProblem: this.problemEmitter.event,
    };
  }

  get currentState(): ConnState {
    return this.state;
  }

  get currentFlavor(): Flavor | undefined {
    return this.flavor;
  }

  /** Tell the stream layer which session to follow (v012 only; legacy mux
   *  broadcasts everything so it is a no-op there). */
  followSession(sessionId: string | undefined): void {
    this.streams?.follow(sessionId);
  }

  private setState(s: ConnState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateEmitter.fire(s);
  }

  async init(): Promise<void> {
    const detected = await detectFlavor(this.baseUrl, 2000);
    if (detected) {
      await this.applyFlavor(detected.flavor, detected.needsAuth);
      this.streams?.start();
      return;
    }
    const cfg = vscode.workspace.getConfiguration("dsh-vscode");
    if (cfg.get<boolean>("autoStart", true)) {
      await this.startDsh();
    } else {
      this.setState("disconnected");
      this.keepDetecting();
    }
  }

  /** Bind the flavor: route the client, build the matching stream layer. */
  private async applyFlavor(flavor: Flavor, needsAuth: boolean): Promise<void> {
    if (this.flavor !== flavor) {
      log(`[lifecycle] protocol flavor: ${flavor}`);
      this.flavor = flavor;
      this.client.setFlavor(flavor);
      this.streams?.stop();
      this.streams = this.buildStreams(flavor);
    }
    if (flavor === "v012" && needsAuth) {
      const ok = await this.auth.ensureCookie(this.baseUrl, this.home);
      if (!ok) {
        this.problemEmitter.fire(
          "DSH 0.1.2+ 服务器需要授权（alpha.5 起强制）：启动 token 由 dsh web 每次启动时随机打印、不落盘。请把启动输出 URL 里的 token 填入设置 dsh-vscode.authToken（服务器重启后需重新填）。",
        );
        this.setState("disconnected");
      }
    }
  }

  private buildStreams(flavor: Flavor): DshStreams {
    const onReady = (gen: number) => {
      log(`[lifecycle] streams ready (gen ${gen}, ${flavor})`);
      this.consecutiveFailures = 0;
      this.setState("connected");
      this.readyEmitter.fire(gen);
    };
    const onBroken = (gen: number) => {
      warn(`[lifecycle] streams broken (gen ${gen}, ${flavor})`);
      this.setState("disconnected");
      this.onStreamFailure();
    };
    const onMux = (f: { rpcId: string; payload: any }) => this.muxEmitter.fire(f);
    const onHost = (f: { rpcId: string; payload: any }) => this.hostEmitter.fire(f);
    if (flavor === "legacy") {
      return new EventStreams({ baseUrl: this.baseUrl, onReady, onBroken, onMux, onHost });
    }
    const v012 = new V012Streams({ baseUrl: this.baseUrl, auth: this.auth, onReady, onBroken, onMux, onHost });
    this.client.bindV012(v012);
    return v012;
  }

  /** Broken generations land here: after a few in a row the server may have
   *  been upgraded (or downgraded) under us — re-detect instead of looping
   *  against a dead endpoint forever. */
  private onStreamFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < 3 || this.detecting) return;
    this.detecting = true;
    void (async () => {
      try {
        const detected = await detectFlavor(this.baseUrl, 3000);
        if (!detected) {
          this.problemEmitter.fire("无法识别 DSH 服务器协议（版本过旧或过新？）——将持续重试。");
          return;
        }
        await this.applyFlavor(detected.flavor, detected.needsAuth);
        this.streams?.start();
      } finally {
        this.detecting = false;
      }
    })();
  }

  /** Background re-detection loop while disconnected (server may appear later). */
  private keepDetecting(): void {
    if (this.probeTimer) return;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined;
      void (async () => {
        const detected = await detectFlavor(this.baseUrl, 1500);
        if (detected) {
          await this.applyFlavor(detected.flavor, detected.needsAuth);
          this.streams?.start();
        } else {
          this.keepDetecting();
        }
      })();
    }, 5000);
  }

  /** Flavor-agnostic liveness probe (used by startDsh polling). */
  async probe(timeoutMs = 2000): Promise<boolean> {
    const detected = await detectFlavor(this.baseUrl, timeoutMs);
    return detected !== undefined;
  }

  /** Start dsh web detached (Windows-only in V1, see design.md known limits).
   *  `attempt` guards the "locate it by hand" retry against loops. */
  async startDsh(attempt = 0): Promise<boolean> {
    this.setState("starting");
    const cfg = vscode.workspace.getConfiguration("dsh-vscode");
    let url: URL;
    try {
      url = new URL(this.baseUrl);
    } catch {
      error("[lifecycle] invalid baseUrl config");
      this.setState("disconnected");
      return false;
    }
    const port = url.port || "3080";
    if (process.platform !== "win32") {
      vscode.window.showErrorMessage("DSH: auto-start is Windows-only in this version. Start `dsh web` manually.");
      this.setState("disconnected");
      return false;
    }

    // Resolve BOTH executables BEFORE Start-Process. A wrong path used to surface
    // only as "did not become ready in 120s" — indistinguishable from a slow boot,
    // because the shipped default was one particular machine's path (2026-09-17 fix).
    const node = locateNodeExe({ explicit: cfg.get<string>("nodePath", "") });
    const bin = locateDshBin({
      explicit: cfg.get<string>("dshBinPath", ""),
      home: this.home,
      extraRoots: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    });
    if (bin.explicitRejected) {
      warn(`[lifecycle] dshBinPath 不是 dsh CLI，已忽略并改为自动探测: ${bin.explicitRejected}`);
    }
    if (node.explicitRejected) {
      warn(`[lifecycle] nodePath 不是 node.exe，已忽略并改为自动探测: ${node.explicitRejected}`);
    }
    if (!node.hit || !bin.hit) {
      await this.reportUnresolved(node, bin, attempt);
      return false;
    }
    const nodePath = node.hit.path;
    const dshBin = bin.hit.path;
    log(`[lifecycle] node = ${nodePath}  ← ${node.hit.source}`);
    log(`[lifecycle] dsh  = ${dshBin}  ← ${bin.hit.source}`);

    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "DSH: starting dsh web…" },
      async () => {
        // Detached via Start-Process so it survives this extension host (memory: 2026-08-14 lesson).
        const home = this.home;
        const logOut = `${home}\\.dsh\\dsh-vscode-web.log`;
        const logErr = `${home}\\.dsh\\dsh-vscode-web.err.log`;
        const ps = [
          `$p = Start-Process -FilePath '${escapePs(nodePath)}'`,
          // --no-open: rc.8+ auto-opens the browser on local starts — wrong
          // here, the user is already IN the VSCode panel doing the starting.
          `-ArgumentList '"${escapePs(dshBin)}" web --no-open --host 127.0.0.1 --port ${port}'`,
          `-WorkingDirectory '${escapePs(home)}'`,
          `-RedirectStandardOutput '${escapePs(logOut)}' -RedirectStandardError '${escapePs(logErr)}'`,
          `-WindowStyle Hidden -PassThru; Write-Host $p.Id`,
        ].join(" ");
        try {
          await runPowerShell(ps, 20_000);
        } catch (err) {
          error(`[lifecycle] Start-Process failed: ${String(err)}`);
          return false;
        }
        // Poll for readiness up to 120s.
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          if (await this.probe(1500)) return true;
          await sleep(2000);
        }
        return false;
      },
    );
    if (started) {
      // The freshly started server may be a NEW flavor than what we saw (or
      // failed to see) before: bind again, then connect. Its launch token
      // lives in our own start log — auth.discoverToken finds it.
      const detected = await detectFlavor(this.baseUrl, 3000);
      if (detected) await this.applyFlavor(detected.flavor, detected.needsAuth);
      this.streams?.retryNow();
      return true;
    }
    const pick = await vscode.window.showErrorMessage(
      "DSH: dsh web did not become ready in 120s.",
      "Show Logs",
    );
    if (pick === "Show Logs") this.showLogs();
    this.setState("disconnected");
    this.keepDetecting();
    return false;
  }

  /** Explain why the start cannot even be attempted, and offer to point at the
   *  file by hand (validated, saved globally, then the start is retried once). */
  private async reportUnresolved(node: LocateOutcome, bin: LocateOutcome, attempt: number): Promise<void> {
    const missingNode = !node.hit;
    const outcome = missingNode ? node : bin;
    const what = missingNode ? "node.exe" : "dsh CLI（lib/bin.js）";
    error(`[lifecycle] 找不到 ${what}，已探测 ${outcome.searched.length} 处：\n  ${outcome.searched.join("\n  ")}`);
    this.setState("disconnected");
    const pick = await vscode.window.showErrorMessage(
      `DSH: 找不到 ${what}，无法拉起 dsh web（已探测 ${outcome.searched.length} 处）。可手动指定路径，插件会记住。`,
      "手动定位…",
      "查看日志",
    );
    if (pick === "查看日志") {
      this.showLogs();
      return;
    }
    if (pick === "手动定位…" && attempt < 2 && (await this.pickExe(missingNode ? "node" : "dsh"))) {
      await this.startDsh(attempt + 1);
    }
  }

  /** File-picker fallback, also used by the `dsh-vscode.locateDsh` command:
   *  validate the choice, then persist it to the user settings. */
  async pickExe(kind: "node" | "dsh"): Promise<boolean> {
    const isNode = kind === "node";
    const key = isNode ? "nodePath" : "dshBinPath";
    // Offer a useful starting folder: the usual install dir when it exists,
    // otherwise its nearest existing ancestor (never the filesystem root).
    const anchor = isNode ? "C:\\Program Files\\nodejs" : path.join(this.home, "dsh");
    const defaultDir = isDir(anchor) ? anchor : nearestExistingDir(anchor, this.home);
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: isNode ? "选择 node.exe" : "选择 ...\\@deepseek-ai\\dsh\\lib\\bin.js",
      defaultUri: vscode.Uri.file(defaultDir),
      filters: isNode ? { "node.exe": ["exe"] } : { "bin.js": ["js"] },
    });
    const p = picked?.[0]?.fsPath;
    if (!p) return false;
    const ok = isNode ? looksLikeNodeExe(p) : looksLikeDshBin(p);
    if (!ok) {
      void vscode.window.showWarningMessage(
        isNode
          ? `DSH: ${p} 不是 node.exe。`
          : `DSH: ${p} 不是 dsh 的 CLI 入口（应形如 ...\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js）。`,
      );
      return false;
    }
    await vscode.workspace.getConfiguration("dsh-vscode").update(key, p, vscode.ConfigurationTarget.Global);
    log(`[lifecycle] 已记住 dsh-vscode.${key} = ${p}`);
    void vscode.window.showInformationMessage(`DSH: 已记住路径 ${p}`);
    return true;
  }

  showLogs(): void {
    vscode.commands.executeCommand("dsh-vscode.showLogs");
  }

  dispose(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.streams?.stop();
    this.stateEmitter.dispose();
    this.readyEmitter.dispose();
    this.muxEmitter.dispose();
    this.hostEmitter.dispose();
    this.problemEmitter.dispose();
  }
}

function escapePs(s: string): string {
  return s.replace(/'/g, "''");
}

function runPowerShell(command: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true },
    );
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        child.kill();
        reject(new Error("powershell timeout"));
      }
    }, timeoutMs);
    child.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`powershell exit ${code}`));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
