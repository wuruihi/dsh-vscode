/**
 * Dual downlink WebSocket streams: /api/events.mux (session domain) and
 * /api/events.host (host domain). Downlink-only; the `ws` library sends no
 * Origin header (browser-only field), so the loopback trust fence passes.
 *
 * Frame shape: {type:"server-request", rpcId:string, method:<payload.type>, payload}.
 * Dispatch on payload.type, NOT on method semantics of "events.mux".
 *
 * mux session-domain frames carry payload.sessionId and are broadcast for ALL
 * sessions; the consumer filters. host frames and stream/error have none.
 */
import WebSocket from "ws";
import { log, warn } from "../log.js";

export interface MuxFrame {
  rpcId: string;
  payload: any;
}

export interface HostFrame {
  rpcId: string;
  payload: any;
}

export type StreamState = "connecting" | "open" | "closed";

export interface EventStreamsOptions {
  baseUrl: string;
  /** Called when BOTH sockets are open (connection generation ready). */
  onReady: (generation: number) => void;
  /** Called when either socket closes (generation broken; reconnect scheduled). */
  onBroken: (generation: number) => void;
  onMux: (frame: MuxFrame) => void;
  onHost: (frame: HostFrame) => void;
}

export class EventStreams {
  private gen = 0;
  private mux: WebSocket | undefined;
  private host: WebSocket | undefined;
  private muxOpen = false;
  private hostOpen = false;
  private readyAnnounced = false;
  private stopped = false;
  private backoffMs = 1000;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly opts: EventStreamsOptions) {}

  get generation(): number {
    return this.gen;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.closeSockets("stopped");
  }

  /** Immediate reconnect attempt (e.g. after user started dsh). */
  retryNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.backoffMs = 1000;
    if (!this.stopped) this.connect();
  }

  private closeSockets(reason: string): void {
    for (const ws of [this.mux, this.host]) {
      if (ws) {
        ws.removeAllListeners();
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.mux = undefined;
    this.host = undefined;
    this.muxOpen = false;
    this.hostOpen = false;
    if (this.readyAnnounced) {
      this.readyAnnounced = false;
      this.opts.onBroken(this.gen);
    } else {
      log(`[ws] sockets closed (${reason}) before ready`);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.closeSockets("reconnect");
    const gen = ++this.gen;
    log(`[ws] connecting generation ${gen}`);
    this.mux = this.openSocket(`${this.opts.baseUrl.replace(/^http/, "ws")}/api/events.mux`, gen, "mux");
    this.host = this.openSocket(`${this.opts.baseUrl.replace(/^http/, "ws")}/api/events.host`, gen, "host");
  }

  private openSocket(url: string, gen: number, which: "mux" | "host"): WebSocket {
    const ws = new WebSocket(url, { handshakeTimeout: 8000 });
    ws.on("open", () => {
      if (gen !== this.gen) return;
      if (which === "mux") this.muxOpen = true;
      else this.hostOpen = true;
      if (this.muxOpen && this.hostOpen) {
        this.backoffMs = 1000;
        this.readyAnnounced = true;
        this.opts.onReady(gen);
      }
    });
    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      if (gen !== this.gen || isBinary) return;
      let frame: any;
      try {
        frame = JSON.parse(data.toString("utf8"));
      } catch {
        warn(`[ws] non-JSON frame on ${which}`);
        return;
      }
      if (frame?.type !== "server-request" || typeof frame.payload !== "object" || !frame.payload) {
        warn(`[ws] unexpected frame shape on ${which}: ${String(frame?.type)}`);
        return;
      }
      if (which === "mux") this.opts.onMux({ rpcId: frame.rpcId, payload: frame.payload });
      else this.opts.onHost({ rpcId: frame.rpcId, payload: frame.payload });
    });
    const fail = (why: string) => {
      if (gen !== this.gen) return;
      warn(`[ws] ${which} ${why} (gen ${gen})`);
      this.scheduleReconnect();
    };
    ws.on("close", () => {
      if (gen !== this.gen) return;
      this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => {
      if (gen !== this.gen) return;
      fail(`error: ${err.message}`);
    });
    return ws;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.timer) return; // already scheduled
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    this.closeSockets("broken");
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.connect();
    }, wait);
  }
}
