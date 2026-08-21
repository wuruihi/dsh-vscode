/**
 * Session manager: owns the current session, prompts, queue/steer, history
 * replay, and the mux frame router. Session-domain mux frames for the CURRENT
 * session are micro-batched (16ms) and forwarded raw to the webview; the fold
 * lives webview-side (incremental by construction — never a full snapshot).
 */
import * as vscode from "vscode";
import { DshLifecycle } from "../connection/lifecycle.js";
import { warn } from "../log.js";
import type { DiffService } from "../diff/provider.js";
import { resolveWorkspace, normalizePath } from "./workspace.js";
import type {
  ApprovalCard,
  ExtToView,
  ModelsData,
  PresetData,
  QuestionCard,
  SessionItem,
} from "../../webview/src/protocol.js";

const BATCH_MS = 16;

export interface ManagerHost {
  /** Push a typed message to the webview (no-op when the view is asleep). */
  post(msg: ExtToView): void;
}

interface SessionRow {
  sessionId: string;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
  projections?: Record<string, unknown>;
}

export class SessionManager {
  private workspaceId: string | undefined;
  private currentSession: string | undefined;
  private sessionRows: SessionRow[] = [];
  private batch: { sessionId: string; frames: unknown[] } | undefined;
  private batchTimer: NodeJS.Timeout | undefined;
  private seenQuestions = new Set<string>();
  private diff: DiffService | undefined;
  private titleCache = new Map<string, string>();
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  private enrichInFlight = false;

  /** The diff collector subscribes to current-session events. */
  bindDiff(diff: DiffService): void {
    this.diff = diff;
  }

  constructor(
    private readonly lifecycle: DshLifecycle,
    private readonly host: ManagerHost,
    private readonly memento?: vscode.Memento,
  ) {
    this.loadPersistedTitles();
    const ev = lifecycle.events;
    ev.onStreamsReady(() => void this.onConnected());
    ev.onMux((f) => this.onMux(f.rpcId, f.payload));
    ev.onHost((f) => this.onHost(f.payload));
  }

  get current(): string | undefined {
    return this.currentSession;
  }

  /** Called on every (re)connect: resolve workspace, load sessions, pick or create one. */
  private async onConnected(): Promise<void> {
    try {
      this.workspaceId = await resolveWorkspace(this.lifecycle.client);
      if (!this.workspaceId) {
        this.host.post({ t: "notify", kind: "error", message: "无法解析 DSH workspace（当前窗口没有打开文件夹？）" });
        return;
      }
      await this.refreshSessions();
      // Reaffirm current session if it still exists, else pick/create.
      if (this.currentSession && this.sessionRows.some((r) => r.sessionId === this.currentSession)) {
        await Promise.all([this.loadHistory(this.currentSession), this.refreshModels(this.currentSession)]);
        return;
      }
      const firstNonBlank = this.sessionRows.find((r) => !r.blank && r.cwd && sameDir(r.cwd));
      const target = firstNonBlank?.sessionId;
      if (target) await this.switchSession(target);
      else await this.newSession();
      this.postPermissionOf(this.currentSession ?? "");
      await this.refreshPresets();
    } catch (err) {
      warn(`[manager] onConnected failed: ${String(err)}`);
      this.host.post({ t: "notify", kind: "error", message: `DSH 会话初始化失败：${String(err)}` });
    }
  }
  async refreshSessions(): Promise<void> {
    const res = await this.lifecycle.client.call<{ items: SessionRow[] }>("session.list", {});
    this.sessionRows = res?.items ?? [];
    this.applyCachedTitles();
    // Post the list IMMEDIATELY (cached titles cover most rows); title
    // enrichment runs in the background and re-posts only if it learned more.
    this.host.post({ t: "sessions", items: this.visibleItems(), current: this.currentSession });
    void this.enrichTitlesInBackground();
  }

  /** session.list carries no titles (projection-only domain): probe each
   *  untitled non-blank session's history tail page for its title projection.
   *  Parallel (capped) — the serial version dominated cold-start latency. */
  private async enrichTitlesInBackground(): Promise<void> {
    if (this.enrichInFlight) return;
    this.enrichInFlight = true;
    try {
      const targets = this.sessionRows
        .filter((r) => !r.blank && !titleOf(r) && !this.titleCache.has(r.sessionId))
        .slice(0, 30);
      if (targets.length === 0) return;
      const CONCURRENCY = 8;
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < targets.length) {
          const row = targets[cursor++];
          try {
            const h = await this.lifecycle.client.call<{ projections?: Record<string, unknown> }>("session.history", {
              sessionId: row.sessionId,
              maxMessages: 1,
            });
            const p = h?.projections as Record<string, any> | undefined;
            const title = p?.values?.title ?? p?.title;
            if (typeof title === "string" && title) this.titleCache.set(row.sessionId, title);
          } catch {
            /* cold/unreadable session: keep id-short label */
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
      this.persistTitles();
      this.applyCachedTitles();
      this.host.post({ t: "sessions", items: this.visibleItems(), current: this.currentSession });
    } finally {
      this.enrichInFlight = false;
    }
  }

  /** Merge cached titles into rows lacking a server-provided one. */
  private applyCachedTitles(): void {
    for (const r of this.sessionRows) {
      const cached = this.titleCache.get(r.sessionId);
      if (cached && !titleOf(r)) {
        r.projections = { ...(r.projections ?? {}), title: cached };
      }
    }
  }

  // ---- title persistence (survives window restarts: no re-probe on boot) ----

  private static readonly TITLES_KEY = "dshVscode.sessionTitles";

  private loadPersistedTitles(): void {
    if (!this.memento) return;
    try {
      const raw = this.memento.get<string>(SessionManager.TITLES_KEY);
      if (!raw) return;
      const obj = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && v) this.titleCache.set(k, v);
      }
    } catch {
      /* corrupt cache: start empty */
    }
  }

  private persistTitles(): void {
    if (!this.memento) return;
    // Cap at 300 entries; Map iterates in insertion order, drop the oldest.
    while (this.titleCache.size > 300) {
      const oldest = this.titleCache.keys().next().value;
      if (oldest === undefined) break;
      this.titleCache.delete(oldest);
    }
    const obj: Record<string, string> = {};
    for (const [k, v] of this.titleCache) obj[k] = v;
    void this.memento.update(SessionManager.TITLES_KEY, JSON.stringify(obj));
  }

  async newSession(): Promise<void> {
    try {
      // Reuse a blank session in this workspace when present (GUI convention).
      const blankRow = this.sessionRows.find((r) => r.blank && r.cwd && sameDir(r.cwd));
      let sessionId = blankRow?.sessionId;
      if (!sessionId) {
        const created = await this.lifecycle.client.call<{ sessionId: string }>("session.create", {
          workspaceId: this.workspaceId,
        });
        sessionId = created.sessionId;
      }
      await this.adoptSession(sessionId);
    } catch (err) {
      this.host.post({ t: "notify", kind: "error", message: `新建会话失败：${String(err)}` });
    }
  }

  async switchSession(sessionId: string): Promise<void> {
    await this.adoptSession(sessionId);
  }

  private async adoptSession(sessionId: string): Promise<void> {
    this.currentSession = sessionId;
    this.host.post({ t: "sessions", items: this.visibleItems(), current: sessionId });
    await Promise.all([this.loadHistory(sessionId), this.refreshModels(sessionId)]);
    this.postPermissionOf(sessionId);
    this.refreshQueue(sessionId);
  }

  private visibleItems(): SessionItem[] {
    return this.sessionRows
      .filter((r) => !r.blank || r.sessionId === this.currentSession) // blank hidden, except the active one (preset picker needs its state)
      .map((r) => ({
        sessionId: r.sessionId,
        title: titleOf(r) ?? this.titleCache.get(r.sessionId),
        running: r.running,
        blank: r.blank,
        cwd: r.cwd,
        agentPreset: r.agentPreset,
      }));
  }

  private async loadHistory(sessionId: string): Promise<void> {
    try {
      const h = await this.lifecycle.client.call<{ events: unknown[]; hasMore: boolean; projections?: Record<string, unknown> }>("session.history", {
        sessionId,
        maxMessages: 24,
      });
      // The tail page carries the projections block — grab the title when present.
      const p = h?.projections as Record<string, any> | undefined;
      const title = p?.values?.title ?? p?.title;
      if (typeof title === "string" && title) {
        const changed = this.titleCache.get(sessionId) !== title;
        this.titleCache.set(sessionId, title);
        if (changed) this.persistTitles();
        const row = this.sessionRows.find((r) => r.sessionId === sessionId);
        if (row) {
          const p = (row.projections ?? {}) as Record<string, any>;
          p.values = { ...(p.values ?? {}), title };
          row.projections = p;
        }
        if (changed) this.host.post({ t: "sessions", items: this.visibleItems(), current: this.currentSession });
      }
      this.host.post({ t: "history", sessionId, entries: h?.events ?? [], hasMore: !!h?.hasMore });
    } catch (err) {
      warn(`[manager] history failed: ${String(err)}`);
      this.host.post({ t: "history", sessionId, entries: [], hasMore: false });
    }
  }

  async forkSession(sessionId: string): Promise<void> {
    try {
      const child = await this.lifecycle.client.call<{ sessionId: string }>("session.fork", { sessionId });
      this.host.post({ t: "notify", kind: "info", message: "已分叉出新会话" });
      await this.refreshSessions();
      await this.adoptSession(child.sessionId);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "fork-unavailable") {
        this.host.post({ t: "notify", kind: "warn", message: "该会话还没有已完成的轮次，无法分叉" });
      } else {
        this.host.post({ t: "notify", kind: "error", message: `分叉失败：${errText(err)}` });
      }
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    if (!this.workspaceId) {
      this.host.post({ t: "notify", kind: "warn", message: "workspace 未就绪，稍后再试" });
      return;
    }
    try {
      await this.lifecycle.client.call("workspace.archiveSession", { workspaceId: this.workspaceId, sessionId });
      if (this.currentSession === sessionId) await this.newSession();
      else await this.refreshSessions();
    } catch (err) {
      this.host.post({ t: "notify", kind: "error", message: `归档失败：${errText(err)}` });
    }
  }

  async loadOlder(sessionId: string, beforeSeq: number): Promise<void> {
    const h = await this.lifecycle.client.call<{ events: unknown[]; hasMore: boolean }>("session.history", {
      sessionId,
      beforeSeq,
      maxMessages: 24,
    });
    this.host.post({ t: "history-older", sessionId, entries: h?.events ?? [], hasMore: !!h?.hasMore });
  }

  async refreshModels(sessionId: string): Promise<void> {
    try {
      const data = await this.lifecycle.client.call<ModelsData>("session.models", { sessionId });
      this.host.post({ t: "models", sessionId, data });
    } catch (err) {
      warn(`[manager] models failed: ${String(err)}`);
    }
  }

  // ---- session-scoped permission (via the /permission slash command) ----
  // DSH has TWO permission lifetimes: settings `permission.defaultPreset`
  // (default for FUTURE sessions only) and the per-session preset switched
  // live through `/permission <id>` — same as the web GUI composer control.

  private postPermissionOf(sessionId: string): void {
    const row = this.sessionRows.find((r) => r.sessionId === sessionId);
    const p = (row?.projections ?? {}) as Record<string, any>;
    const perm = p.values?.permissions ?? p.permissions;
    const value = typeof perm?.currentValue === "string" ? perm.currentValue : null;
    const opts = Array.isArray(perm?.options)
      ? perm.options
          .map((o: any) => ({ id: String(o?.value ?? ""), label: String(o?.name ?? o?.value ?? "") }))
          .filter((o: { id: string }) => o.id)
      : [];
    if (value || opts.length > 0) {
      this.host.post({ t: "permission", data: { value, revision: null, presets: opts } });
    }
  }

  async setSessionPermission(sessionId: string, preset: string): Promise<void> {
    // Commands ride the typert RPC `commands/execute` (note the SLASH method
    // name and the args envelope) — the same path the web GUI and the old
    // dsh-vsc use. session.prompt does NOT dispatch slash commands on this
    // host build: the text would leak to the model as a user message.
    try {
      const value = await this.lifecycle.client.call<{ commandId: string; result?: { kind: string; text?: string } } | null>(
        "commands/execute",
        { args: { agentId: sessionId, line: `/permission ${preset}` } },
      );
      if (!value) {
        this.host.post({ t: "notify", kind: "error", message: "当前主机没有 /permission 命令" });
        return;
      }
      if (value.result?.kind === "error") {
        this.host.post({ t: "notify", kind: "warn", message: `权限切换被拒绝：${value.result.text ?? ""}` });
        return;
      }
      // The permissions projection push updates the selector; no local echo.
    } catch (err) {
      this.host.post({ t: "notify", kind: "error", message: `权限切换失败：${errText(err)}` });
    }
  }

  // ---- agent presets (native: locked after the first turn) ----

  async refreshPresets(): Promise<void> {
    try {
      const data = await this.lifecycle.client.call<PresetData>("agentPreset.list", {});
      this.host.post({ t: "presets", data });
    } catch (err) {
      warn(`[manager] preset list failed: ${String(err)}`);
    }
  }

  async selectPreset(sessionId: string, agentPreset: string): Promise<void> {
    try {
      await this.lifecycle.client.call("agentPreset.select", { sessionId, agentPreset });
      const row = this.sessionRows.find((r) => r.sessionId === sessionId);
      if (row) row.agentPreset = agentPreset;
      this.host.post({ t: "sessions", items: this.visibleItems(), current: this.currentSession });
      await this.refreshModels(sessionId);
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "agent-preset-locked") {
        this.host.post({ t: "notify", kind: "warn", message: "会话已发过消息，模式已固定，不能切换（新建会话可选）" });
      } else {
        this.host.post({ t: "notify", kind: "error", message: `切换模式失败：${errText(err)}` });
      }
    }
  }

  private refreshQueue(_sessionId: string): void {
    // Queue snapshots arrive only as session/queue mux frames (the server
    // replays a baseline on every connect); there is no queue RPC to call.
  }

  private pushQueue(sessionId: string, items: { id: string; placement: string; content: { type: string; text?: string }[] }[]): void {
    if (sessionId !== this.currentSession) return; // queue strip renders only the active session's queue
    this.host.post({
      t: "queue",
      sessionId,
      items: items.map((i) => ({ id: i.id, placement: i.placement, text: (i.content ?? []).map((c) => c.text ?? "").join("") })),
    });
  }

  async prompt(sessionId: string, mode: "queue" | "steer", parts: unknown[]): Promise<void> {
    try {
      await this.lifecycle.client.call("session.prompt", {
        sessionId,
        mode,
        content: await expandFileParts(parts),
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || undefined,
      });
    } catch (err) {
      this.host.post({ t: "notify", kind: "error", message: `发送失败：${errText(err)}` });
    }
  }

  async cancel(sessionId: string): Promise<void> {
    try {
      await this.lifecycle.client.call("session.cancel", { sessionId });
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `中断失败：${errText(err)}` });
    }
  }

  async rename(sessionId: string, title: string): Promise<void> {
    try {
      await this.lifecycle.client.call("session.rename", { sessionId, title });
      await this.refreshSessions();
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `重命名失败：${errText(err)}` });
    }
  }

  async selectModel(sessionId: string, provider: string, model: string, reasoningEffort?: string): Promise<void> {
    try {
      await this.lifecycle.client.call("session.selectModel", {
        sessionId,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      await this.refreshModels(sessionId);
      this.host.post({ t: "notify", kind: "info", message: `模型已切换：${model}` });
    } catch (err) {
      this.host.post({ t: "notify", kind: "error", message: `切换模型失败：${errText(err)}` });
      await this.refreshModels(sessionId);
    }
  }

  async queueRemove(sessionId: string, itemId: string): Promise<void> {
    try {
      await this.lifecycle.client.call("session.updateQueue", { sessionId, itemId, action: { kind: "remove" } });
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `移除队列项失败：${errText(err)}` });
    }
  }

  async respondApproval(rpcId: string, sessionId: string, approvalId: string, outcome: "allowed-once" | "rejected"): Promise<void> {
    const receipt = await this.lifecycle.client.respond(rpcId, { sessionId, approvalId, outcome });
    if (!receipt.accepted) {
      // not-pending: another client (GUI/second window) already answered — the
      // resolved event will withdraw our card; just inform.
      this.host.post({ t: "notify", kind: "info", message: "该审批已在其他端处理" });
    }
  }

  async respondQuestion(rpcId: string, sessionId: string, answers: { id: string; selected: string[]; custom?: string }[]): Promise<void> {
    const receipt = await this.lifecycle.client.respond(rpcId, { sessionId, answer: { answers } });
    if (!receipt.accepted) {
      this.host.post({ t: "notify", kind: "info", message: "该提问已在其他端处理" });
    }
  }

  // ---- mux routing ----

  /** Debounced post-turn reconciliation: coalesce rapid turn/end bursts
   *  (subagent-heavy turns), keep the current session only. */
  private scheduleSettle(sid: string): void {
    if (sid !== this.currentSession) return;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = undefined;
      if (sid === this.currentSession) void this.loadHistory(sid);
    }, 400);
  }

  private onMux(rpcId: string, payload: any): void {
    const type = payload?.type;
    if (type === "session/event") {
      const sid = payload.sessionId;
      if (sid !== this.currentSession) return; // other sessions: GUI's business
      const ev = payload.event;
      if (this.diff && ev?.type) this.diff.onSessionEvent(ev);
      this.enqueueFrame(payload);
      // Track running state cheaply for the session list.
      if (ev?.type === "turn/start") this.markRunning(sid, true);
      if (ev?.type === "turn/end") {
        this.markRunning(sid, false);
        // Reconcile: live chunk accumulation can drop/dup deltas (16ms batching,
        // reconnects), leaving a permanently-broken dsh-ui fence in the fold.
        // The history tail is authoritative — rebuild the view from it.
        this.scheduleSettle(sid);
      }
      return;
    }
    if (type === "session/subscribed") return; // baseline bookkeeping only
    if (type === "session/projection") {
      const sid = payload.sessionId;
      this.host.post({ t: "projection", sessionId: sid, key: payload.key, value: payload.value });
      if (payload.key === "title" && typeof payload.value === "string") {
        this.titleCache.set(sid, payload.value);
        const row = this.sessionRows.find((r) => r.sessionId === sid);
        if (row) {
          const p = (row.projections ?? {}) as Record<string, any>;
          p.values = { ...(p.values ?? {}), title: payload.value };
          row.projections = p;
          this.host.post({ t: "sessions", items: this.visibleItems(), current: this.currentSession });
        }
      }
      if (payload.key === "permissions" && payload.sessionId === this.currentSession) {
        const perm = payload.value;
        const value = typeof perm?.currentValue === "string" ? perm.currentValue : null;
        const opts = Array.isArray(perm?.options)
          ? perm.options
              .map((o: any) => ({ id: String(o?.value ?? ""), label: String(o?.name ?? o?.value ?? "") }))
              .filter((o: { id: string }) => o.id)
          : [];
        if (value || opts.length > 0) this.host.post({ t: "permission", data: { value, revision: null, presets: opts } });
      }
      return;
    }
    if (type === "session/queue") {
      this.pushQueue(payload.sessionId, payload.items ?? []);
      return;
    }
    if (type === "approval/requested") {
      const card: ApprovalCard = {
        sessionId: payload.sessionId,
        approvalId: payload.approvalId,
        rpcId,
        toolName: payload.toolName,
        reason: payload.reason,
        extra: pickExtra(payload, ["approvalId", "toolName", "reason"]),
      };
      this.host.post({ t: "approval", card });
      return;
    }
    if (type === "approval/resolved") {
      this.host.post({ t: "approval-gone", approvalId: payload.approvalId });
      return;
    }
    if (type === "question/requested") {
      // Pending questions replay on reconnect with stable rpcId — dedupe.
      if (this.seenQuestions.has(rpcId)) return;
      this.seenQuestions.add(rpcId);
      const card: QuestionCard = { sessionId: payload.sessionId, rpcId, questions: payload.questions ?? [] };
      this.host.post({ t: "question", card });
      return;
    }
    if (type === "question/resolved") {
      this.seenQuestions.delete(payload.questionRpcId ?? rpcId);
      this.host.post({ t: "question-gone", rpcId: payload.questionRpcId ?? rpcId });
      return;
    }
    if (type === "stream/error") {
      const detail = (() => {
        try {
          return JSON.stringify(payload.error)?.slice(0, 200) ?? "unknown";
        } catch {
          return "unknown";
        }
      })();
      this.host.post({ t: "notify", kind: "error", message: `DSH 流错误：${detail}` });
      return;
    }
  }

  private markRunning(sid: string, running: boolean): void {
    const row = this.sessionRows.find((r) => r.sessionId === sid);
    if (row && row.running !== running) {
      row.running = running;
      this.host.post({ t: "sessions", items: this.visibleItems(), current: this.currentSession });
    }
  }

  private enqueueFrame(payload: unknown): void {
    if (!this.batch) this.batch = { sessionId: this.currentSession!, frames: [] };
    this.batch.frames.push(payload);
    if (this.batchTimer) return;
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined;
      const b = this.batch;
      this.batch = undefined;
      if (b && b.frames.length > 0) this.host.post({ t: "mux-batch", sessionId: b.sessionId, frames: b.frames });
    }, BATCH_MS);
  }

  private onHost(payload: any): void {
    const type = payload?.type;
    if (type === "host/session-added" || type === "host/session-removed" || type === "host/session-status") {
      // Defer to a light refresh (session.list is the reconnect authority).
      void this.refreshSessions().catch(() => undefined);
    }
    if (type === "stream/error") {
      warn(`[manager] host stream error: ${JSON.stringify(payload.error)?.slice(0, 200)}`);
    }
  }

  /** webview came back alive (reload): rebuild its view. */
  async onWebviewReady(): Promise<void> {
    this.host.post({ t: "conn", state: this.lifecycle.currentState });
    if (this.currentSession) {
      await this.refreshSessions();
      await Promise.all([
        this.loadHistory(this.currentSession),
        this.refreshModels(this.currentSession),
        this.refreshPresets(),
      ]);
      this.postPermissionOf(this.currentSession);
    } else if (this.lifecycle.currentState === "connected") {
      await this.onConnected();
    }
  }
}

function titleOf(r: SessionRow): string | undefined {
  // DSH shape: projections.values.title (rc.7 nests projection payloads
  // under `values` with asOfSeq). Tolerate the flat legacy shape too.
  const p = r.projections as Record<string, any> | undefined;
  const t = p?.values?.title ?? p?.title;
  return typeof t === "string" ? t : undefined;
}

function pickExtra(payload: Record<string, unknown>, known: string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (known.includes(k) || v == null) continue;
    out[k] = typeof v === "object" ? JSON.stringify(v).slice(0, 200) : String(v).slice(0, 200);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sameDir(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const folders = vscode.workspace.workspaceFolders;
  const root = folders?.[0]?.uri.fsPath;
  if (!root) return false;
  return normalizePath(cwd) === normalizePath(root);
}

function errText(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return `${(err as any).code}: ${(err as any).message}`;
  }
  return String(err);
}

// ---- @ file attachment expansion (webview cannot read the filesystem) ----

const FILE_PART_MAX_CHARS = 20_000;

async function expandFileParts(parts: unknown[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object" || (p as any).type !== "file") {
      out.push(p);
      continue;
    }
    const path = String((p as any).path ?? "");
    const rel = String((p as any).rel ?? path);
    try {
      const { readFile } = await import("node:fs/promises");
      let text = await readFile(path, "utf8");
      if (text.length > FILE_PART_MAX_CHARS) {
        text = `${text.slice(0, FILE_PART_MAX_CHARS)}\n…（已截断至 ${FILE_PART_MAX_CHARS} 字符）`;
      }
      out.push({ type: "text", text: `[引用文件 ${rel}]\n${text}` });
    } catch (err) {
      out.push({ type: "text", text: `[引用文件 ${rel} 读取失败：${errText(err)}]` });
    }
  }
  return out;
}
