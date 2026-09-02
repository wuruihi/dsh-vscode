/**
 * v012 stream layer: the single /api/remote.mux WebSocket (0.1.2+ wire
 * contract, design.md §3.0) behind the SAME callback surface the legacy
 * EventStreams exposes — so the SessionManager consumes one shape of
 * "mux payload" no matter which server generation it talks to.
 *
 * Synthesis map (v012 frame → legacy-shaped payload for the manager):
 *  session/follow "event"        → {type:"session/event", sessionId, event, view?}
 *  session/control "queue"       → {type:"session/queue", sessionId, items(normalized)}
 *  session/control "projection"  → {type:"session/projection", sessionId, key, value}
 *  session/control "baseline"    → queue+projection frames for every session
 *  $events waterfall approval/request        → {type:"approval/requested", ...} rpcId=eventId
 *  $events waterfall user-questions/request  → {type:"question/requested", ...} rpcId=eventId
 *  $events cancel                  → approval/resolved + question/resolved (idempotent)
 *  $events emit api-session/added|removed|status → host/session-* (manager just refreshes)
 */
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Auth } from "./auth.js";
import { log, warn } from "../log.js";

export interface StreamHandle {
  cancel(): void;
}

interface StreamEntry {
  onItem: (value: unknown) => void;
  onEnd: () => void;
  onError: (error: { code: string; message: string }) => void;
}

interface StreamCallbacks {
  onItem: (value: unknown) => void;
  onEnd?: () => void;
  onError?: (error: { code: string; message: string }) => void;
}

export interface V012StreamsOptions {
  baseUrl: string;
  auth: Auth;
  onReady: (generation: number) => void;
  onBroken: (generation: number) => void;
  onMux: (frame: { rpcId: string; payload: any }) => void;
  onHost: (frame: { rpcId: string; payload: any }) => void;
}

/** One logical stream frame contract (0.1.2-alpha.4):
 *  client→server {type:"open",streamId,endpoint,payload:{args}} | {type:"cancel",streamId}
 *  server→client {type:"item",streamId,value} | {type:"end",streamId}
 *               | {type:"error",streamId,error:{code,message,details}} */
export class V012Streams {
  private ws: WebSocket | undefined;
  private stopped = false;
  private gen = 0;
  private backoffMs = 1000;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private readyAnnounced = false;
  private streams = new Map<string, StreamEntry>();
  private pendingOpens: { streamId: string; endpoint: string; args: unknown }[] = [];
  private nextStreamId = 0;

  /** Persistent streams (re-opened on every socket generation). */
  private clientId: string | undefined;
  private desiredFollow: string | undefined;
  private controlHandle: StreamHandle | undefined;
  private workspaceHandle: StreamHandle | undefined;
  private eventsHandle: StreamHandle | undefined;
  private followHandle: StreamHandle | undefined;

  constructor(private readonly opts: V012StreamsOptions) {}

  get generation(): number {
    return this.gen;
  }

  /** $events ready clientId — needed to answer waterfalls via $events/result. */
  get eventsClientId(): string | undefined {
    return this.clientId;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardownSocket("stopped");
  }

  retryNow(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.backoffMs = 1000;
    if (!this.stopped) this.connect();
  }

  /** Follow the current session (legacy flavor has no equivalent — mux
   *  broadcasts everything). Safe to call repeatedly; re-opens on reconnect. */
  follow(sessionId: string | undefined): void {
    this.desiredFollow = sessionId;
    if (sessionId && this.ws && this.ws.readyState === WebSocket.OPEN) this.openFollow(sessionId);
  }

  /** One-shot history tail page for `session.history` under v012. */
  snapshotOnce(
    sessionId: string,
    maxMessages: number,
    timeoutMs = 10_000,
  ): Promise<{ entries: unknown[]; hasMore: boolean; projections?: Record<string, unknown>; cursor?: number }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { entries: unknown[]; hasMore: boolean; projections?: Record<string, unknown>; cursor?: number }) => {
        if (settled) return;
        settled = true;
        handle.cancel();
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ entries: [], hasMore: false }), timeoutMs);
      const handle = this.openStream(
        "session/follow",
        { request: { address: { kind: "session", sessionId }, ...(maxMessages !== undefined ? { maxMessages } : {}) } },
        {
          onItem: (value) => {
            const frame = value as { type?: string; records?: { event: unknown; view?: unknown }[]; hasMore?: boolean; projections?: Record<string, unknown>; cursor?: number };
            if (frame?.type === "snapshot") {
              finish({
                entries: (frame.records ?? []).map((r) => ({ event: r.event, view: r.view })),
                hasMore: !!frame.hasMore,
                projections: frame.projections,
                cursor: frame.cursor,
              });
            }
          },
          onError: () => finish({ entries: [], hasMore: false }),
        },
      );
    });
  }

  /** One-shot workspace baseline for `workspace.list` under v012. */
  workspacesOnce(timeoutMs = 10_000): Promise<{ items?: { workspaceId: string; path: string; title?: string; sessionIds?: string[] }[] }> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: { items?: { workspaceId: string; path: string; title?: string; sessionIds?: string[] }[] }) => {
        if (settled) return;
        settled = true;
        handle.cancel();
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ items: [] }), timeoutMs);
      const handle = this.openStream(
        "workspace/follow",
        {},
        {
          onItem: (value) => {
            const frame = value as { type?: string; value?: { items?: { workspaceId: string; path: string; title?: string; sessionIds?: string[] }[] } };
            if (frame?.type === "baseline") finish({ items: frame.value?.items ?? [] });
          },
          onError: () => finish({ items: [] }),
        },
      );
    });
  }

  /** Open (or queue) a logical stream. */
  openStream(endpoint: string, args: unknown, cbs: StreamCallbacks): StreamHandle {
    const streamId = `s${this.nextStreamId++}`;
    const entry: StreamEntry = {
      onItem: cbs.onItem,
      onEnd: cbs.onEnd ?? (() => undefined),
      onError: cbs.onError ?? (() => undefined),
    };
    this.streams.set(streamId, entry);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send({ type: "open", streamId, endpoint, payload: { args } });
    } else {
      this.pendingOpens.push({ streamId, endpoint, args });
    }
    return {
      cancel: () => {
        this.streams.delete(streamId);
        this.pendingOpens = this.pendingOpens.filter((p) => p.streamId !== streamId);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) this.send({ type: "cancel", streamId });
      },
    };
  }

  // ---- internals ----

  private connect(): void {
    if (this.stopped) return;
    this.teardownSocket("reconnect");
    const gen = ++this.gen;
    const url = `${this.opts.baseUrl.replace(/^http/, "ws")}/api/remote.mux`;
    log(`[v012] connecting generation ${gen}: ${url}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { handshakeTimeout: 8000, headers: this.opts.auth.cookieHeader() });
    } catch (err) {
      warn(`[v012] socket create failed: ${String(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.on("open", () => {
      if (gen !== this.gen || this.ws !== ws) return;
      log(`[v012] mux open (gen ${gen})`);
      this.backoffMs = 1000;
      // Re-open persistent streams + flush queued opens.
      this.openPersistentStreams();
      for (const p of this.pendingOpens) this.send({ type: "open", streamId: p.streamId, endpoint: p.endpoint, payload: { args: p.args } });
      this.pendingOpens = [];
      if (!this.readyAnnounced) {
        this.readyAnnounced = true;
        this.opts.onReady(gen);
      }
    });
    ws.on("message", (data, isBinary) => {
      if (gen !== this.gen || this.ws !== ws || isBinary) return;
      let frame: any;
      try {
        frame = JSON.parse(data.toString("utf8"));
      } catch {
        warn("[v012] non-JSON frame");
        return;
      }
      this.dispatch(frame);
    });
    ws.on("close", () => {
      if (gen !== this.gen || this.ws !== ws) return;
      this.scheduleReconnect();
    });
    ws.on("error", (err) => {
      if (gen !== this.gen || this.ws !== ws) return;
      warn(`[v012] socket error: ${err.message}`);
      this.scheduleReconnect();
    });
  }

  private dispatch(frame: any): void {
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "item" || frame.type === "end" || frame.type === "error") {
      const entry = this.streams.get(frame.streamId);
      if (!entry) return;
      if (frame.type === "item") entry.onItem(frame.value);
      else if (frame.type === "end") {
        this.streams.delete(frame.streamId);
        entry.onEnd();
      } else {
        this.streams.delete(frame.streamId);
        entry.onError({ code: String(frame.error?.code ?? "stream-error"), message: String(frame.error?.message ?? "stream error") });
      }
      return;
    }
    warn(`[v012] unexpected frame type: ${String(frame.type)}`);
  }

  private openPersistentStreams(): void {
    // Drop stale generation handles (their streamIds died with the socket).
    this.controlHandle?.cancel();
    this.workspaceHandle?.cancel();
    this.eventsHandle?.cancel();
    this.followHandle?.cancel();

    this.controlHandle = this.openStream("session/control", {}, {
      onItem: (v) => this.onControl(v),
      onError: () => undefined, // socket-level failures surface via reconnect
    });
    this.workspaceHandle = this.openStream("workspace/follow", {}, {
      onItem: () => undefined, // workspace list is pulled one-shot via workspacesOnce()
      onError: () => undefined,
    });
    this.eventsHandle = this.openStream("$events", {}, {
      onItem: (v) => this.onRemoteEvent(v),
      onError: () => undefined,
    });
    if (this.desiredFollow) this.openFollow(this.desiredFollow);
  }

  private openFollow(sessionId: string): void {
    this.followHandle?.cancel();
    this.followHandle = this.openStream(
      "session/follow",
      { request: { address: { kind: "session", sessionId } } },
      {
        onItem: (v) => {
          const frame = v as { type?: string; event?: unknown; view?: unknown };
          if (frame?.type === "event" && frame.event) {
            // Live events for the followed session; the snapshot frame is
            // history's business (snapshotOnce), ignored here.
            this.opts.onMux({
              rpcId: "",
              payload: { type: "session/event", sessionId, event: frame.event, ...(frame.view !== undefined ? { view: frame.view } : {}) },
            });
          }
        },
        onError: () => warn(`[v012] follow error for ${sessionId}`),
      },
    );
  }

  private onControl(value: unknown): void {
    const frame = value as
      | { type: "baseline"; value: { queues?: Record<string, unknown[]>; projections?: Record<string, { values?: Record<string, unknown> }> } }
      | { type: "queue"; sessionId: string; items: unknown[] }
      | { type: "projection"; sessionId: string; key: string; value: unknown };
    if (frame?.type === "baseline") {
      for (const [sessionId, items] of Object.entries(frame.value?.queues ?? {})) this.emitQueue(sessionId, items);
      for (const [sessionId, proj] of Object.entries(frame.value?.projections ?? {})) {
        for (const [key, value] of Object.entries(proj?.values ?? {})) {
          this.opts.onMux({ rpcId: "", payload: { type: "session/projection", sessionId, key, value } });
        }
      }
      return;
    }
    if (frame?.type === "queue") {
      this.emitQueue(frame.sessionId, frame.items ?? []);
      return;
    }
    if (frame?.type === "projection") {
      this.opts.onMux({ rpcId: "", payload: { type: "session/projection", sessionId: frame.sessionId, key: frame.key, value: frame.value } });
    }
  }

  /** Normalize v012 queue items ({message:{content}}) into the legacy flat
   *  shape ({content}) the manager's pushQueue expects. */
  private emitQueue(sessionId: string, items: unknown[]): void {
    const normalized = items.map((raw) => {
      const i = raw as { id?: string; placement?: string; content?: unknown[]; message?: { content?: unknown[] } };
      return {
        id: String(i?.id ?? ""),
        placement: String(i?.placement ?? "queued"),
        content: i?.message?.content ?? i?.content ?? [],
      };
    });
    this.opts.onMux({ rpcId: "", payload: { type: "session/queue", sessionId, items: normalized } });
  }

  private onRemoteEvent(value: unknown): void {
    const frame = value as
      | { type: "ready"; clientId: string }
      | { type: "emit"; event: string; args: unknown[] }
      | { type: "waterfall"; event: string; eventId: string; agentId: string; request: any }
      | { type: "cancel"; eventId: string };
    if (frame?.type === "ready") {
      this.clientId = frame.clientId;
      log(`[v012] $events ready (client ${frame.clientId.slice(0, 8)}…)`);
      return;
    }
    if (frame?.type === "emit") {
      // api-session/* replaces the legacy host/* domain for list refresh.
      if (frame.event === "api-session/added") this.opts.onHost({ rpcId: "", payload: { type: "host/session-added" } });
      else if (frame.event === "api-session/removed") this.opts.onHost({ rpcId: "", payload: { type: "host/session-removed" } });
      else if (frame.event === "api-session/status") this.opts.onHost({ rpcId: "", payload: { type: "host/session-status" } });
      return; // commands/agent-preset/cordis events: session.list refresh covers us
    }
    if (frame?.type === "waterfall") {
      if (frame.event === "approval/request") {
        const req = frame.request ?? {};
        this.opts.onMux({
          rpcId: frame.eventId,
          payload: {
            type: "approval/requested",
            sessionId: frame.agentId,
            approvalId: frame.eventId,
            toolName: req.toolName,
            reason: req.reason,
            ...(req.callId ? { callId: String(req.callId) } : {}),
          },
        });
        return;
      }
      if (frame.event === "user-questions/request") {
        this.opts.onMux({
          rpcId: frame.eventId,
          payload: { type: "question/requested", sessionId: frame.agentId, questions: frame.request?.questions ?? [] },
        });
        return;
      }
      return;
    }
    if (frame?.type === "cancel") {
      // Another client answered (or it timed out): retire both card kinds —
      // each handler ignores ids it does not know.
      this.opts.onMux({ rpcId: frame.eventId, payload: { type: "approval/resolved", approvalId: frame.eventId, outcome: "other" } });
      this.opts.onMux({ rpcId: frame.eventId, payload: { type: "question/resolved", questionRpcId: frame.eventId } });
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    this.teardownSocket("broken");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, wait);
  }

  private teardownSocket(reason: string): void {
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    // Every logical stream died with the socket.
    const dead = [...this.streams.values()];
    this.streams.clear();
    this.pendingOpens = [];
    for (const e of dead) e.onError({ code: "stream/socket-closed", message: `remote.mux closed (${reason})` });
    if (this.readyAnnounced) {
      this.readyAnnounced = false;
      this.opts.onBroken(this.gen);
    }
  }

  private send(frame: unknown): void {
    try {
      this.ws?.send(JSON.stringify(frame));
    } catch (err) {
      warn(`[v012] send failed: ${String(err)}`);
    }
  }
}

/** requestId generator shared with the client adapter (0.1.2 session.prompt
 *  requires a client-minted id). */
export function newRequestId(): string {
  return randomUUID();
}
