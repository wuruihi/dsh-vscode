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
import { parsePinnedModel, pickChatDefault, realModelOf, type ModelChoice } from "./model-choice.js";
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
  /** Wire fact (probed): sessions spawned by the session's own agent carry
   *  origin:"subagent" + parentSessionId. Top-level user sessions have
   *  neither. Same cwd — they used to leak through the workspace filter. */
  origin?: string;
  parentSessionId?: string;
}

export class SessionManager {
  private workspaceId: string | undefined;
  private currentSession: string | undefined;
  private sessionRows: SessionRow[] = [];
  private batch: { sessionId: string; frames: unknown[] } | undefined;
  private batchTimer: NodeJS.Timeout | undefined;
  private seenQuestions = new Set<string>();
  /** Generation-scoped approval cards: rpcId -> approvalId. */
  private seenApprovals = new Map<string, string>();
  /** question signature -> live rpcId: a replayed pending question arrives
   *  with a FRESH rpcId each reconnect; the signature swap retires the stale
   *  card so the user can only ever answer the live one. */
  private questionSig = new Map<string, string>();
  private diff: DiffService | undefined;
  private titleCache = new Map<string, string>();
  /** sessionId → the model THAT session is set to use (from the host's
   *  modelSelection projection). Kept so the panel never has to guess from the
   *  host-wide catalog default, which is shared across projects. */
  private sessionModel = new Map<string, ModelChoice>();
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
    /** Per-workspace memento: scopes the "last used model" default to THIS
     *  project, so cross-project global-last leakage never lands here. */
    private readonly wsMemento?: vscode.Memento,
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
    // Generation boundary: the host's pending table re-mints rpcIds on every
    // mux replay, so last generation's question/approval cards are stale —
    // answering them lands not-pending. Withdraw them all; the replay that
    // follows this socket open re-adds the live ones.
    this.dropGenerationCards();
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
        .filter((r) => !r.blank && r.origin !== "subagent" && !titleOf(r) && !this.titleCache.has(r.sessionId))
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
      await this.applyWsDefaultModel(sessionId);
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
    // v012 follow must open BEFORE the history snapshot: events racing the
    // snapshot are de-duplicated webview-side by seq (fold), but events
    // between a snapshot and a later follow-open would be lost forever.
    this.lifecycle.followSession(sessionId);
    this.host.post({ t: "sessions", items: this.visibleItems(), current: sessionId });
    await Promise.all([this.loadHistory(sessionId), this.refreshModels(sessionId)]);
    this.postPermissionOf(sessionId);
    this.refreshQueue(sessionId);
  }

  private visibleItems(): SessionItem[] {
    // Subagent child count per parent (for the row badge) — counted before
    // the subagent rows themselves are hidden from the list.
    const kids = new Map<string, { total: number; running: number }>();
    for (const r of this.sessionRows) {
      if (r.origin === "subagent" && r.parentSessionId) {
        const k = kids.get(r.parentSessionId) ?? { total: 0, running: 0 };
        k.total++;
        if (r.running) k.running++;
        kids.set(r.parentSessionId, k);
      }
    }
    return this.sessionRows
      // Workspace-bound list: only this project's sessions (cwd match); the
      // active session stays visible even on a cwd edge (adopt/fork races).
      // Subagent sessions are the agent's own workers, not user switchable
      // conversations (they share cwd and used to pollute the list) — hidden,
      // surfaced instead as a count badge on the parent row.
      .filter((r) => r.sessionId === this.currentSession || (!r.blank && r.origin !== "subagent" && sameDir(r.cwd)))
      .map((r) => ({
        sessionId: r.sessionId,
        title: titleOf(r) ?? this.titleCache.get(r.sessionId),
        running: r.running,
        blank: r.blank,
        cwd: r.cwd,
        agentPreset: r.agentPreset,
        subagents: kids.get(r.sessionId),
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
      // Seed UI projections (plan mode / todos) from the history page so a
      // switched-to session shows its state before any live push arrives.
      const pv = (p?.values ?? p ?? {}) as Record<string, any>;
      this.host.post({ t: "projection", sessionId, key: "plan", value: pv.plan ?? { active: false } });
      this.host.post({ t: "projection", sessionId, key: "todos", value: pv.todos ?? null });
      this.host.post({ t: "projection", sessionId, key: "goal", value: pv.goal ?? null });
      // The session's OWN model (host projection): the chip must show what this
      // session runs, not the host-wide catalog default. Also feeds this
      // workspace's "last model used here" memory for new chats.
      this.noteSessionModel(sessionId, pv.modelSelection);
      this.postCurrentModel(sessionId, pv.modelSelection);
    } catch (err) {
      warn(`[manager] history failed: ${String(err)}`);
      this.host.post({ t: "history", sessionId, entries: [], hasMore: false });
    }
  }

  async forkSession(sessionId: string): Promise<void> {
    await this.forkSessionInternal(sessionId);
  }

  /** Fork at a specific point (turn pill / action bar): the new session
   *  copies everything through atSeq. */
  async forkSessionAt(sessionId: string, atSeq: number): Promise<void> {
    await this.forkSessionInternal(sessionId, atSeq);
  }

  private async forkSessionInternal(sessionId: string, atSeq?: number): Promise<void> {
    try {
      const child = await this.lifecycle.client.call<{ sessionId: string }>("session.fork", {
        sessionId,
        ...(atSeq !== undefined ? { atSeq } : {}),
      });
      this.host.post({ t: "notify", kind: "info", message: atSeq !== undefined ? `已从第 ${atSeq} 号事件处分叉出新会话` : "已分叉出新会话" });
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
      // `session/models` reports the host-wide catalog default — the model a
      // NEW chat starts on, shared by every project. An EXISTING session keeps
      // its own model, so displaying the catalog default here was a lie: a
      // session running glm-5.3 showed the global default (real bug
      // 2026-09-11 — it read as "my switch didn't apply"). Prefer the session's
      // own model when the modelSelection projection has told us what it is.
      const real = this.sessionModel.get(sessionId);
      if (real) data.current = real;
      this.host.post({ t: "models", sessionId, data });
    } catch (err) {
      warn(`[manager] models failed: ${String(err)}`);
    }
  }

  /** ---- workspace-scoped default model ----
   *  Host default for a new session is the GLOBAL last-used model — projects
   *  running in parallel cross-contaminate (A's chats flip to B's model).
   *  Priority on a new chat: PINNED setting (dsh-vscode.defaultModel, in the
   *  workspace's .vscode/settings.json — deterministic, mistake-proof) >
   *  last model used inside THIS workspace > host global (first-ever run). */
  private rememberWsModel(cur: { provider: string; model: string; reasoningEffort?: string }): void {
    void this.wsMemento?.update("dsh.lastModel", cur);
  }

  /** Record a session's OWN model (from the host's modelSelection projection):
   *  cache it for the chip, and — only for a real session of THIS workspace —
   *  make it this project's "last model used", which new chats inherit.
   *  Blank sessions and other workspaces are ignored so projects never leak
   *  into each other (the whole point of the workspace-scoped memory). */
  private noteSessionModel(sessionId: string, modelSelection: unknown): void {
    const real = realModelOf(modelSelection);
    if (!real) return;
    this.sessionModel.set(sessionId, real);
    const row = this.sessionRows.find((r) => r.sessionId === sessionId);
    // Subagent children can run a different model; they must not become the
    // project's "last model used" for the user's own new chats.
    if (!row || row.blank || row.origin === "subagent" || !row.cwd || !sameDir(row.cwd)) return;
    this.rememberWsModel(real);
  }

  /** Push the session's resolved model to the panel (chip + effort picker). */
  private postCurrentModel(sessionId: string, modelSelection: unknown): void {
    this.host.post({ t: "projection", sessionId, key: "currentModel", value: realModelOf(modelSelection) ?? null });
  }

  /** Parse the pinned "provider/model[/effort]" setting. Null = unset/malformed. */
  private pinnedModel(): ModelChoice | null {
    const raw = vscode.workspace.getConfiguration("dsh-vscode").get<string>("defaultModel", "");
    const { choice, malformed } = parsePinnedModel(raw);
    if (malformed) {
      this.host.post({ t: "notify", kind: "warn", message: `dsh-vscode.defaultModel 格式应为 "provider/model"（当前："${malformed}"），已忽略` });
      return null;
    }
    return choice ?? null;
  }

  private async applyWsDefaultModel(sessionId: string): Promise<void> {
    // 1) pinned setting (deterministic per-project default; unset by default)
    const pin = this.pinnedModel();
    // 2) this workspace's own last-used model (never the host-wide default:
    //    another project's chat must not decide this project's model)
    const wsLast = this.wsMemento?.get<{ provider: string; model: string; reasoningEffort?: string }>("dsh.lastModel");
    const target = pickChatDefault(pin, wsLast);
    if (!target) return; // first-ever chat here: let the host decide
    // A pin that the host rejects must not be silently replaced by memory —
    // warn and stop; a stale last-used memory is dropped so the host can rule.
    const fromPin = pin?.provider === target.provider && pin?.model === target.model;
    try {
      const res = await this.lifecycle.client.call<{ selected?: ModelChoice }>("session.selectModel", {
        sessionId,
        provider: target.provider,
        model: target.model,
        ...(target.reasoningEffort ? { reasoningEffort: target.reasoningEffort } : {}),
      });
      const applied = res?.selected ?? target;
      this.sessionModel.set(sessionId, applied);
      this.postCurrentModel(sessionId, { next: applied, lastUsed: applied });
      if (fromPin) {
        this.host.post({ t: "notify", kind: "info", message: `已应用本项目默认模型：${applied.provider}/${applied.model}` });
      }
    } catch (err) {
      if (fromPin) {
        // User-authored config: never auto-clear — warn and stop.
        this.host.post({ t: "notify", kind: "warn", message: `本项目默认模型 ${target.provider}/${target.model} 应用失败（${String(err).slice(0, 80)}）` });
        return;
      }
      // Stale memory (model/provider since removed): drop it, host default rules.
      warn(`[manager] ws default model apply failed (${String(err)}) — clearing memory`);
      void this.wsMemento?.update("dsh.lastModel", undefined);
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

  /** Pull one durable image's bytes for the webview (rc.8+ hosts log images
   *  as {attachmentId} refs; pre-rc.8 hosts never get asked — inline parts
   *  render client-side). Failure degrades to a broken-image placeholder. */
  async getAttachment(sessionId: string, attachmentId: string): Promise<void> {
    try {
      const v = await this.lifecycle.client.call<{ attachment?: { mediaType?: string }; data?: string }>(
        "session.attachment",
        { sessionId, attachmentId },
      );
      this.host.post({
        t: "attachment",
        sessionId,
        attachmentId,
        mediaType: typeof v?.attachment?.mediaType === "string" ? v.attachment.mediaType : "image/png",
        data: typeof v?.data === "string" ? v.data : "",
      });
    } catch (err) {
      warn(`[manager] attachment fetch failed (${attachmentId}): ${errText(err)}`);
      this.host.post({ t: "attachment-error", sessionId, attachmentId });
    }
  }

  /** Slash-menu entries: skills (insert `/name ` text — the host pre-step
   *  gesture injects content) + built-in commands (dispatch via RPC).
   *  Wire reality (live-probed): skills ride the apiproxy endpoint
   *  "skill.list" (singular) {sessionId}; commands ride the typert gateway
   *  "commands/list" with {args:{agentId}} through the same /api carrier. */
  async listSlash(sessionId: string): Promise<{ kind: "skill" | "command"; name: string; description: string }[]> {
    const out: { kind: "skill" | "command"; name: string; description: string }[] = [];
    const [skills, commands] = await Promise.allSettled([
      this.lifecycle.client.call("skill.list", { sessionId }),
      this.lifecycle.client.call("commands/list", { args: { agentId: sessionId } }),
    ]);
    if (skills.status === "fulfilled") {
      const list = (skills.value as { skills?: unknown[] })?.skills ?? (Array.isArray(skills.value) ? skills.value : []);
      for (const s of list as Record<string, unknown>[]) {
        if (typeof s?.name === "string") {
          out.push({ kind: "skill", name: s.name, description: String(s.description ?? "") });
        }
      }
    }
    if (commands.status === "fulfilled") {
      const list = Array.isArray(commands.value) ? commands.value : [];
      for (const c of list as Record<string, unknown>[]) {
        // skills and commands share the `/name` grammar: a same-named skill wins
        if (typeof c?.name === "string" && !out.some((o) => o.name === c.name)) {
          out.push({ kind: "command", name: c.name, description: String(c.description ?? "") });
        }
      }
    }
    if (skills.status === "rejected" && commands.status === "rejected") {
      this.host.post({ t: "notify", kind: "warn", message: `技能列表获取失败：${errText(skills.reason)}` });
    }
    return out;
  }

  async runCommand(sessionId: string, line: string): Promise<void> {
    try {
      await this.lifecycle.client.call("commands/execute", { args: { agentId: sessionId, line } });
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `命令执行失败：${errText(err)}` });
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
      // The host normalises the choice (resolveCallConfig) — echo ITS value,
      // not the requested one, so the chip/memory can never drift from what the
      // session will actually request next.
      const res = await this.lifecycle.client.call<{ selected?: ModelChoice }>("session.selectModel", {
        sessionId,
        provider,
        model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      });
      const selected: ModelChoice = res?.selected ?? { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) };
      this.rememberWsModel(selected);
      this.sessionModel.set(sessionId, selected);
      this.postCurrentModel(sessionId, { next: selected, lastUsed: selected });
      await this.refreshModels(sessionId);
      this.host.post({ t: "notify", kind: "info", message: `模型已切换：${selected.model}` });
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

  /** Replace a pending queued item's text (server action kind:"edit"). */
  async queueEdit(sessionId: string, itemId: string, text: string): Promise<void> {
    try {
      await this.lifecycle.client.call("session.updateQueue", {
        sessionId,
        itemId,
        action: { kind: "edit", content: [{ type: "text", text }] },
      });
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `编辑队列项失败：${errText(err)}` });
    }
  }

  /** Promote a queued item to a steering message (server action kind:"steer") —
   *  it jumps the queue and takes effect on the running turn. */
  async queueSteer(sessionId: string, itemId: string): Promise<void> {
    try {
      await this.lifecycle.client.call("session.updateQueue", { sessionId, itemId, action: { kind: "steer" } });
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `插队失败：${errText(err)}` });
    }
  }

  /** List a session's subagents (rc.2 subagent.list / 0.1.2 subagents/list). */
  async listSubagents(sessionId: string): Promise<void> {
    try {
      const res = await this.lifecycle.client.call<{ entries: unknown[] }>("subagent.list", { parentSessionId: sessionId });
      this.host.post({ t: "subagents", sessionId, entries: (Array.isArray(res?.entries) ? res.entries : []) as any });
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `子代理列表获取失败：${errText(err)}` });
      this.host.post({ t: "subagents", sessionId, entries: [] });
    }
  }

  /** Subagent transcript. Wire fact (probed on alpha.5): the gateway does
   *  NOT expose subagent.* to client Remotes ("invalid Remote endpoint" on
   *  the stream carrier, 404 over HTTP) — the child IS a session, so we go
   *  through session.history (snapshot/page adapter) with the child id. */
  async subagentHistory(childId: string): Promise<void> {
    try {
      const h = await this.lifecycle.client.call<{ events: unknown[] }>("session.history", { sessionId: childId, maxMessages: 400 });
      this.host.post({ t: "subagent-history", sessionId: childId, entries: ((h?.events ?? []) as any) });
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `子代理对话读取失败：${errText(err)}` });
      this.host.post({ t: "subagent-history", sessionId: childId, entries: [] });
    }
  }

  /** Steer a continuable subagent: session.prompt pointed at the child id. */
  async subagentPrompt(childId: string, text: string): Promise<void> {
    try {
      await this.lifecycle.client.call("session.prompt", {
        sessionId: childId,
        mode: "queue",
        content: [{ type: "text", text }],
      });
      this.host.post({ t: "notify", kind: "info", message: "已发送给子代理" });
      await this.subagentHistory(childId);
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `子代理追问失败：${errText(err)}` });
    }
  }

  /** Interrupt a running subagent: session.cancel pointed at the child id
   *  (probe: fake id → session/not-found — schema accepted). */
  async subagentInterrupt(childId: string): Promise<void> {
    try {
      await this.lifecycle.client.call("session.cancel", { sessionId: childId });
      this.host.post({ t: "notify", kind: "info", message: "已请求打断子代理" });
      await this.subagentHistory(childId);
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `子代理打断失败：${errText(err)}` });
    }
  }

  /** workspace.list → follow-baseline adapter (read path; workspace/list has
   *  no HTTP route on alpha.5 — mutations DO: probed arguments-invalid on
   *  fake ids = endpoints exist, schema-checked). */
  async listWorkspaces(): Promise<void> {
    try {
      const res = await this.lifecycle.client.call<{ items?: unknown[]; archivedSessionIds?: string[] }>("workspace.list", {});
      this.host.post({ t: "workspaces", items: (res?.items ?? []) as any, archivedSessionIds: res?.archivedSessionIds ?? [] });
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `工作区列表读取失败：${errText(err)}` });
      this.host.post({ t: "workspaces", items: [], archivedSessionIds: [] });
    }
  }

  /** All workspace mutations refresh the list afterwards (single code path). */
  private async workspaceOp(label: string, method: string, args: Record<string, unknown>): Promise<void> {
    try {
      await this.lifecycle.client.call(method, args);
      this.host.post({ t: "notify", kind: "info", message: `${label}完成` });
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `${label}失败：${errText(err)}` });
    }
    await this.listWorkspaces();
  }

  workspaceRename(workspaceId: string, title: string) {
    return this.workspaceOp("工作区重命名", "workspace.rename", { workspaceId, title });
  }

  workspaceMove(workspaceId: string, beforeWorkspaceId?: string) {
    return this.workspaceOp("工作区移动", "workspace.insertBefore", { workspaceId, ...(beforeWorkspaceId ? { beforeWorkspaceId } : {}) });
  }

  workspaceDelete(workspaceId: string) {
    return this.workspaceOp("工作区删除", "workspace.delete", { workspaceId });
  }

  workspaceCreate(path: string) {
    return this.workspaceOp("工作区添加", "workspace.create", { path });
  }

  workspaceMoveSession(sessionId: string, toWorkspaceId: string) {
    return this.workspaceOp("会话移组", "workspace.insertSessionBefore", { workspaceId: toWorkspaceId, sessionId });
  }

  /** settings/describe for the schema-driven settings sheet. */
  async describeSettings(): Promise<void> {
    try {
      const res = await this.lifecycle.client.call<{ writable: boolean; hasDocument: boolean; namespaces: unknown[] }>("settings.describe", {});
      this.host.post({ t: "settings-describe", data: { writable: !!res?.writable, hasDocument: !!res?.hasDocument, namespaces: (res?.namespaces ?? []) as any } });
    } catch (err) {
      this.host.post({ t: "notify", kind: "warn", message: `服务器设置读取失败：${errText(err)}` });
      this.host.post({ t: "settings-describe", data: { writable: false, hasDocument: false, namespaces: [] } });
    }
  }

  /** settings/update with optimistic revision (probed wire: {ns, patch,
   *  expectedRevision} → ok + refreshed namespace). */
  async saveSetting(ns: string, patch: Record<string, unknown>, revision: number): Promise<void> {
    try {
      const res = await this.lifecycle.client.call<{ ok: boolean; error?: { message?: string } }>("settings.update", { ns, patch, expectedRevision: revision });
      const ok = res?.ok !== false;
      this.host.post({ t: "settings-saved", ns, ok, ...(ok ? {} : { error: String((res as any)?.error?.message ?? res?.error ?? "保存失败") }) });
      if (ok) await this.describeSettings();
    } catch (err) {
      this.host.post({ t: "settings-saved", ns, ok: false, error: errText(err) });
    }
  }

  /** Withdraw every pending question/approval card from the webview and
   *  reset the generation-scoped bookkeeping. Called at each socket
   *  generation boundary — replays will re-add whatever is still live. */
  private dropGenerationCards(): void {
    for (const rpcId of this.seenQuestions) this.host.post({ t: "question-gone", rpcId });
    for (const approvalId of this.seenApprovals.values()) {
      if (approvalId) this.host.post({ t: "approval-gone", approvalId });
    }
    this.seenQuestions.clear();
    this.seenApprovals.clear();
    this.questionSig.clear();
  }

  async respondApproval(rpcId: string, sessionId: string, approvalId: string, outcome: "allowed-once" | "rejected"): Promise<void> {
    const receipt = await this.lifecycle.client.respond(rpcId, { sessionId, approvalId, outcome });
    if (!receipt.accepted) {
      // not-pending: this card's rpcId went stale across a reconnect — the
      // live replay has minted (or will mint) a fresh card. Withdraw ours so
      // the user cannot keep clicking a dead card; answer on the live one.
      this.seenApprovals.delete(rpcId);
      if (receipt.reason === "not-pending") this.host.post({ t: "approval-gone", approvalId });
      this.host.post({
        t: "notify",
        kind: "warn",
        message: receipt.reason === "not-pending" ? "该审批已失效：可能已被其他窗口处理或已超时；若 DSH 仍在等待会出现新的审批卡" : "审批应答被拒绝，请重试",
      });
    }
  }

  async respondQuestion(rpcId: string, sessionId: string, answers: { id: string; selected: string[]; custom?: string }[]): Promise<void> {
    const receipt = await this.lifecycle.client.respond(rpcId, { sessionId, answer: { answers } });
    if (!receipt.accepted) {
      this.seenQuestions.delete(rpcId);
      for (const [sig, id] of this.questionSig) if (id === rpcId) this.questionSig.delete(sig);
      if (receipt.reason === "not-pending") this.host.post({ t: "question-gone", rpcId });
      this.host.post({
        t: "notify",
        kind: "warn",
        message: receipt.reason === "not-pending" ? "该提问已失效：可能已被其他窗口应答或已超时；若 DSH 仍在等待会弹出新的提问卡" : "应答被拒绝，请重试",
      });
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
    if (type === "session/jobs" || type === "jobs") {
      // Background-job ledger frames (bash/pwsh/subagent jobs started by the
      // agent). Current-session only — same rule as other panel state.
      if (payload.sessionId && payload.sessionId !== this.currentSession) return;
      this.host.post({ t: "jobs", sessionId: payload.sessionId ?? this.currentSession, jobs: Array.isArray(payload.jobs) ? payload.jobs : [] });
      return;
    }
    if (type === "session/projection") {
      const sid = payload.sessionId;
      // Panel state (todos/plan/tokens/permissions) is current-session only.
      // Title is the one cross-session projection we keep: it feeds the
      // session-list cache for THIS workspace's rows.
      if (payload.key !== "title") {
        // modelSelection is remembered for EVERY session of this workspace (the
        // project's "last model used" must follow the newest session, not only
        // the one on screen), but only the current session paints the panel.
        if (payload.key === "modelSelection") this.noteSessionModel(sid, payload.value);
        if (sid !== this.currentSession) return;
        this.host.post({ t: "projection", sessionId: sid, key: payload.key, value: payload.value });
        if (payload.key === "modelSelection") this.postCurrentModel(sid, payload.value);
        if (payload.key === "permissions") {
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
      if (typeof payload.value === "string") {
        this.titleCache.set(sid, payload.value);
        const row = this.sessionRows.find((r) => r.sessionId === sid);
        if (row) {
          const p = (row.projections ?? {}) as Record<string, any>;
          p.values = { ...(p.values ?? {}), title: payload.value };
          row.projections = p;
          this.host.post({ t: "sessions", items: this.visibleItems(), current: this.currentSession });
        }
      }
      return;
    }
    if (type === "session/queue") {
      this.pushQueue(payload.sessionId, payload.items ?? []);
      return;
    }
    if (type === "approval/requested") {
      // Workspace gate: the host broadcasts approvals from EVERY session to
      // EVERY client — a foreign project's approval card must never surface
      // in this window. Dropped copies are not lost: the owning client (and
      // the GUI, which shows all workspaces) still renders them.
      if (!this.ownsSession(payload.sessionId)) return;
      this.seenApprovals.set(rpcId, String(payload.approvalId ?? ""));
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
      // Same workspace gate as approvals — questions pop where they belong.
      if (!this.ownsSession(payload.sessionId)) return;
      // Pending questions replay with a LIVE rpcId per generation; within a
      // generation the rpcId is stable. Signature swap retires the stale
      // duplicate so exactly one live card stays answerable.
      if (this.seenQuestions.has(rpcId)) return;
      const sig = `${payload.sessionId}|${(payload.questions ?? []).map((q: any) => String(q?.id ?? "")).join(",")}`;
      const prevRpcId = this.questionSig.get(sig);
      if (prevRpcId && prevRpcId !== rpcId) {
        this.host.post({ t: "question-gone", rpcId: prevRpcId });
        this.seenQuestions.delete(prevRpcId);
      }
      this.questionSig.set(sig, rpcId);
      this.seenQuestions.add(rpcId);
      const card: QuestionCard = { sessionId: payload.sessionId, rpcId, questions: payload.questions ?? [] };
      this.host.post({ t: "question", card });
      return;
    }
    if (type === "question/resolved") {
      const gone = payload.questionRpcId ?? rpcId;
      this.seenQuestions.delete(gone);
      for (const [sig, id] of this.questionSig) if (id === gone) this.questionSig.delete(sig);
      this.host.post({ t: "question-gone", rpcId: gone });
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

  /** Session-ownership gate — the ONE place that decides whether a broadcast
   *  event belongs to this window. The host has no per-workspace
   *  subscriptions: every client receives every session's events, so scoping
   *  is the client's contract. A session is ours when it is the current one
   *  (created/adopted in this workspace) or its row's cwd matches the
   *  workspace root. Unknown rows are NOT ours: a foreign client's
   *  just-created session (not yet in our refreshed list) must never
   *  surface here; our own fresh sessions are current before they can
   *  produce events. */
  private ownsSession(sid: string | undefined): boolean {
    if (!sid) return false;
    if (sid === this.currentSession) return true;
    const row = this.sessionRows.find((r) => r.sessionId === sid);
    return !!row && !row.blank && !!row.cwd && sameDir(row.cwd);
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
    const fsp = await import("node:fs/promises");
    try {
      const st = await fsp.stat(path);
      if (st.isDirectory()) {
        // Directory reference: shallow listing (names only, one level).
        const names = await fsp.readdir(path);
        const listing = names.slice(0, 200).join("\n");
        out.push({
          type: "text",
          text: `[引用目录 ${rel} 共 ${names.length} 项]\n${listing}${names.length > 200 ? "\n…（仅列前 200 项）" : ""}`,
        });
        continue;
      }
      let text = await fsp.readFile(path, "utf8");
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
