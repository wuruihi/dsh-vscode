/**
 * Connection lifecycle: probe the running dsh web, optionally start it
 * (Windows-only detached Start-Process), own the RpcClient + EventStreams,
 * and publish a small state machine to the UI.
 */
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { RpcClient } from "./client.js";
import { EventStreams } from "./events.js";
import { log, warn, error } from "../log.js";

export type ConnState = "connecting" | "connected" | "disconnected" | "starting";

export interface DshServiceEvents {
  onState: vscode.Event<ConnState>;
  /** Emitted on every WS-ready generation (initial connect + reconnects). */
  onStreamsReady: vscode.Event<number>;
  onMux: vscode.Event<{ rpcId: string; payload: any }>;
  onHost: vscode.Event<{ rpcId: string; payload: any }>;
}

export class DshLifecycle {
  private state: ConnState = "connecting";
  private readonly stateEmitter = new vscode.EventEmitter<ConnState>();
  private readonly readyEmitter = new vscode.EventEmitter<number>();
  private readonly muxEmitter = new vscode.EventEmitter<{ rpcId: string; payload: any }>();
  private readonly hostEmitter = new vscode.EventEmitter<{ rpcId: string; payload: any }>();
  private probeTimer: NodeJS.Timeout | undefined;

  readonly client: RpcClient;
  readonly streams: EventStreams;

  constructor(private readonly baseUrl: string) {
    this.client = new RpcClient(baseUrl);
    this.streams = new EventStreams({
      baseUrl,
      onReady: (gen) => {
        log(`[lifecycle] streams ready (gen ${gen})`);
        this.setState("connected");
        this.readyEmitter.fire(gen);
      },
      onBroken: (gen) => {
        warn(`[lifecycle] streams broken (gen ${gen})`);
        this.setState("disconnected");
      },
      onMux: (f) => this.muxEmitter.fire(f),
      onHost: (f) => this.hostEmitter.fire(f),
    });
  }

  get events(): DshServiceEvents {
    return {
      onState: this.stateEmitter.event,
      onStreamsReady: this.readyEmitter.event,
      onMux: this.muxEmitter.event,
      onHost: this.hostEmitter.event,
    };
  }

  get currentState(): ConnState {
    return this.state;
  }

  private setState(s: ConnState): void {
    if (this.state === s) return;
    this.state = s;
    this.stateEmitter.fire(s);
  }

  async init(): Promise<void> {
    // Fast probe first; if unreachable and autoStart, offer to start.
    const up = await this.probe(1500);
    if (up) {
      this.streams.start();
      return;
    }
    const cfg = vscode.workspace.getConfiguration("dsh-vscode");
    if (cfg.get<boolean>("autoStart", true)) {
      await this.startDsh();
    } else {
      this.setState("disconnected");
      this.streams.start(); // keep retrying in background
    }
  }

  async probe(timeoutMs = 2000): Promise<boolean> {
    try {
      await this.client.call("host.describe", {}, timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Start dsh web detached (Windows-only in V1, see design.md known limits). */
  async startDsh(): Promise<boolean> {
    this.setState("starting");
    const cfg = vscode.workspace.getConfiguration("dsh-vscode");
    const nodePath = cfg.get<string>("nodePath", "");
    const dshBin = cfg.get<string>("dshBinPath", "");
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
    const started = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "DSH: starting dsh web…" },
      async () => {
        // Detached via Start-Process so it survives this extension host (memory: 2026-08-14 lesson).
        const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
        const logOut = `${home}\\.dsh\\dsh-vscode-web.log`;
        const logErr = `${home}\\.dsh\\dsh-vscode-web.err.log`;
        const ps = [
          `$p = Start-Process -FilePath '${escapePs(nodePath)}'`,
          `-ArgumentList '"${escapePs(dshBin)}" web --host 127.0.0.1 --port ${port}'`,
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
      this.streams.retryNow();
      return true;
    }
    const pick = await vscode.window.showErrorMessage(
      "DSH: dsh web did not become ready in 120s.",
      "Show Logs",
    );
    if (pick === "Show Logs") this.showLogs();
    this.setState("disconnected");
    this.streams.start();
    return false;
  }

  showLogs(): void {
    vscode.commands.executeCommand("dsh-vscode.showLogs");
  }

  dispose(): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.streams.stop();
    this.stateEmitter.dispose();
    this.readyEmitter.dispose();
    this.muxEmitter.dispose();
    this.hostEmitter.dispose();
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
