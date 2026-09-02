/**
 * DSH RPC client, flavor-aware (design.md §3.0).
 *
 * legacy (0.1.1-rc.x):
 * - POST /api/<method> with payload sent as-is (dot-style methods)
 * - approvals/questions answered via POST /api/respond (bare carrier receipt)
 *
 * v012 (0.1.2-alpha.4+):
 * - POST /api/<namespace>/<method> with payload wrapped as {args}
 * - method renames + per-method arg/value adaptation live HERE (one table)
 * - auth cookie on every request; 401/403 → cookie refresh → one retry
 * - approvals/questions answered via $events/result (needs the $events
 *   clientId, supplied by the bound V012Streams)
 *
 * The rest of the extension keeps speaking legacy method names into
 * `call()` — this class is the single translation point.
 */
import type { Auth } from "./auth.js";
import type { V012Streams } from "./remote.js";
import { makeRpcId, type Flavor } from "./protocol.js";

export class DshRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "DshRpcError";
  }
}

export class DshNetworkError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "DshNetworkError";
  }
}

/** v012 server requires a cookie we could not obtain (no launch token). */
export class DshAuthNeededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DshAuthNeededError";
  }
}

export type RespondReceipt =
  | { accepted: true }
  | { accepted: false; reason: "not-pending" | "bad-response" };

export interface ContentPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
  name?: string;
}

/** Straight endpoint renames with identical args/values. */
const METHOD_MAP: Record<string, string> = {
  "session.list": "session/list",
  "session.create": "session/create",
  "session.prompt": "session/prompt",
  "session.cancel": "session/cancel",
  "session.updateQueue": "session/updateQueue",
  "session.rename": "session/rename",
  "session.fork": "session/fork",
  "session.attachment": "session/attachment",
  "session.selectModel": "session/selectModel",
  "workspace.create": "workspace/create",
  "agentPreset.list": "agentPresets/list",
  "skill.list": "skills/list",
  "commands/list": "commands/list",
  "commands/execute": "commands/execute",
};

export class RpcClient {
  private nextId = 0;
  private flavor: Flavor = "legacy";
  private v012: V012Streams | undefined;
  /** sessionId → follow cursor (v012 session/page upper bound). */
  private historyCursor = new Map<string, number>();

  constructor(
    private readonly baseUrl: string,
    private readonly auth: Auth,
    private readonly home: string = process.env.USERPROFILE ?? process.env.HOME ?? "",
  ) {}

  setFlavor(flavor: Flavor): void {
    this.flavor = flavor;
    this.historyCursor.clear();
  }

  get currentFlavor(): Flavor {
    return this.flavor;
  }

  /** The v012 stream layer is constructed after the client (it needs auth);
   *  lifecycle binds it back once detection picked the v012 flavor. */
  bindV012(streams: V012Streams): void {
    this.v012 = streams;
  }

  /** Unary RPC call. Throws DshRpcError (business) or DshNetworkError (transport). */
  async call<T = unknown>(method: string, payload: any, timeoutMs = 30_000): Promise<T> {
    if (this.flavor === "legacy") return this.legacyCall<T>(method, payload, timeoutMs);
    return this.v012Call<T>(method, payload, timeoutMs);
  }

  /** Answer a pending approval/question. Value shape discriminates the kind:
   *  {sessionId, approvalId, outcome} vs {sessionId, answer:{answers}} — the
   *  same shapes the legacy /api/respond path consumes. */
  async respond(rpcId: string, value: unknown, timeoutMs = 30_000): Promise<RespondReceipt> {
    if (this.flavor === "legacy") return this.legacyRespond(rpcId, value, timeoutMs);

    const v = (value ?? {}) as Record<string, unknown>;
    const outcomeValue = "answer" in v ? v.answer : "outcome" in v ? v.outcome : value;
    try {
      const res = await this.v012Request<{ accepted?: boolean; reason?: string }>(
        "$events/result",
        {
          clientId: this.v012?.eventsClientId,
          eventId: rpcId,
          outcome: { kind: "result", value: outcomeValue },
        },
        timeoutMs,
      );
      if (res && typeof res === "object" && "accepted" in res) {
        return res.accepted === true
          ? { accepted: true }
          : { accepted: false, reason: res.reason === "not-pending" ? "not-pending" : "bad-response" };
      }
      return { accepted: true }; // value-undefined receipts mean "accepted, no payload"
    } catch (err) {
      if (err instanceof DshRpcError) return { accepted: false, reason: "bad-response" };
      throw err;
    }
  }

  // ---------- legacy wire (0.1.1-rc.x) ----------

  private async legacyCall<T>(method: string, payload: unknown, timeoutMs: number): Promise<T> {
    const rpcId = this.makeRpcId();
    const envelope = { type: "client-request", rpcId, method, payload };
    const body = await this.post(`/api/${method}`, envelope, timeoutMs, false);
    return this.unwrap<T>(body, rpcId, method);
  }

  private async legacyRespond(rpcId: string, value: unknown, timeoutMs: number): Promise<RespondReceipt> {
    const envelope = { type: "client-response", rpcId, result: { ok: true, value } };
    try {
      const body = await this.post("/api/respond", envelope, timeoutMs, false);
      if (body && typeof body === "object" && "accepted" in body) {
        return body.accepted === true
          ? { accepted: true }
          : { accepted: false, reason: body.reason === "not-pending" ? "not-pending" : "bad-response" };
      }
      return { accepted: false, reason: "bad-response" };
    } catch (err) {
      if (err instanceof DshRpcError) {
        // respond rejects malformed values with rpc errors; treat as bad-response
        return { accepted: false, reason: "bad-response" };
      }
      throw err;
    }
  }

  // ---------- v012 wire (0.1.2+) ----------
  //
  // Gateway contract (live-probed on 0.1.2-alpha.4, dsh-api-gateway
  // assertExactArguments): `args` carries EXACTLY one key per business
  // parameter, keyed by the parameter name (`request`, `_request`) or the
  // lookup wire (`agent` → `agentId`). Extra or missing keys are rejected.
  // Single-`request` methods therefore wrap as {request:{...}}; `agent`
  // methods spread flat; `images` is a mandatory wire field on commands/execute.

  private async v012Call<T>(method: string, payload: any, timeoutMs: number): Promise<T> {
    // Structurally different methods first.
    if (method === "session.history") return this.v012History<T>(payload, timeoutMs);
    if (method === "workspace.list") {
      if (!this.v012) throw new DshNetworkError("workspace.list before v012 streams bound");
      const res = await this.v012.workspacesOnce(timeoutMs);
      return { items: res.items ?? [] } as T;
    }
    if (method === "session.models") {
      const cat = await this.v012Request<any>("session/modelCatalog", {}, timeoutMs);
      return {
        current: cat?.default,
        routable: Array.isArray(cat?.routableProviders) ? cat.routableProviders.length > 0 : true,
        groups: cat?.groups,
        failures: cat?.failures,
      } as T;
    }
    if (method === "session.list") {
      const value = await this.v012Request<any>("session/list", { _request: {} }, timeoutMs);
      return { items: (value?.items ?? []).map(normalizeSessionRow) } as T;
    }
    if (method === "agentPreset.list") {
      return this.v012Request<T>("agentPresets/list", {}, timeoutMs);
    }
    if (method === "agentPreset.select") {
      return this.v012Request<T>("agentPresets/select", { agentId: payload?.sessionId, agentPreset: payload?.agentPreset }, timeoutMs);
    }
    if (method === "skill.list") {
      return this.v012Request<T>("skills/list", { request: { sessionId: payload?.sessionId } }, timeoutMs);
    }
    if (method === "subagent.list") {
      // rc.2: subagent.list {parentSessionId}; 0.1.2: subagents/list {request:{parentSessionId}}
      return this.v012Request<T>("subagents/list", { request: { parentSessionId: payload?.parentSessionId } }, timeoutMs);
    }
    if (method === "commands/list") {
      return this.v012Request<T>("commands/list", { agentId: payload?.args?.agentId }, timeoutMs);
    }
    if (method === "commands/execute") {
      return this.v012Request<T>("commands/execute", {
        agentId: payload?.args?.agentId,
        line: payload?.args?.line,
        images: payload?.args?.images ?? [],
      }, timeoutMs);
    }

    // request-wrapped unary methods (identical field names inside).
    const wrapped = new Set([
      "session.create",
      "session.cancel",
      "session.rename",
      "session.fork",
      "session.attachment",
      "session.updateQueue",
      "session.selectModel",
      "workspace.create",
      "workspace.archiveSession",
    ]);
    if (wrapped.has(method)) {
      const endpoint = METHOD_MAP[method] ?? method.replace(/\./g, "/");
      const request =
        method === "workspace.archiveSession"
          ? { sessionId: payload?.sessionId } // 0.1.2 dropped workspaceId
          : { ...(payload ?? {}) };
      return this.v012Request<T>(endpoint, { request }, timeoutMs);
    }

    if (method === "session.prompt") {
      // 0.1.2 requires a client-minted request id.
      return this.v012Request<T>("session/prompt", { request: { ...payload, requestId: makeRpcId("prompt") } }, timeoutMs);
    }

    // Unknown method: best-effort slash mapping with args as-is (loose parsing
    // policy — let the server reject it loudly rather than guessing silently).
    return this.v012Request<T>(method.replace(/\./g, "/"), payload, timeoutMs);
  }

  /** legacy `session.history` over the v012 wire: tail pages come from a
   *  one-shot session/follow snapshot (which also yields the paging cursor),
   *  older pages from session/page. */
  private async v012History<T>(
    payload: { sessionId: string; maxMessages?: number; beforeSeq?: number },
    timeoutMs: number,
  ): Promise<T> {
    if (!this.v012) throw new DshNetworkError("session.history before v012 streams bound");
    if (payload?.beforeSeq === undefined) {
      const snap = await this.v012.snapshotOnce(payload.sessionId, payload.maxMessages ?? 24, timeoutMs);
      if (snap.cursor !== undefined) this.historyCursor.set(payload.sessionId, snap.cursor);
      return {
        events: snap.entries,
        hasMore: snap.hasMore,
        projections: snap.projections,
      } as T;
    }
    const throughSeq = this.historyCursor.get(payload.sessionId) ?? payload.beforeSeq;
    const value = await this.v012Request<any>(
      "session/page",
      {
        request: {
          address: { kind: "session", sessionId: payload.sessionId },
          throughSeq,
          ...(payload.beforeSeq !== undefined ? { beforeSeq: payload.beforeSeq } : {}),
          ...(payload.maxMessages !== undefined ? { maxMessages: payload.maxMessages } : {}),
        },
      },
      timeoutMs,
    );
    return {
      events: (value?.records ?? []).map((r: any) => ({ event: r?.event, view: r?.view })),
      hasMore: !!value?.hasMore,
    } as T;
  }

  /** v012 POST with {args} envelope + cookie auth (one refresh retry). */
  private async v012Request<T>(endpoint: string, args: unknown, timeoutMs: number, isRetry = false): Promise<T> {
    const rpcId = this.makeRpcId();
    const envelope = { type: "client-request", rpcId, method: endpoint, payload: { args } };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth.cookieHeader() },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DshNetworkError(`transport failure on ${endpoint}: ${String(err)}`, err);
    }
    if ((res.status === 401 || res.status === 403) && !isRetry) {
      this.auth.invalidate();
      const ok = await this.auth.ensureCookie(this.baseUrl, this.home);
      if (!ok) throw new DshAuthNeededError(`DSH 0.1.2+ 服务器需要授权 cookie（未能从启动日志获取 token）`);
      return this.v012Request<T>(endpoint, args, timeoutMs, true);
    }
    if (res.status === 401 || res.status === 403) {
      throw new DshAuthNeededError("DSH 0.1.2+ 认证失败：token 无效或已过期");
    }
    if (!res.ok) throw new DshNetworkError(`HTTP ${res.status} on ${endpoint}`);
    let body: any;
    try {
      body = await res.json();
    } catch (err) {
      throw new DshNetworkError(`non-JSON response on ${endpoint}`, err);
    }
    return this.unwrap<T>(body, rpcId, endpoint);
  }

  // ---------- shared ----------

  private unwrap<T>(body: any, rpcId: string, method: string): T {
    if (body?.type !== "server-response" || body.rpcId !== rpcId) {
      throw new DshNetworkError(`unexpected response envelope for ${method}`);
    }
    const result = body.result;
    if (result && result.ok === true) return result.value as T;
    const e = result && result.ok === false ? result.error : undefined;
    throw new DshRpcError(e?.code ?? "internal", e?.message ?? `RPC ${method} failed`, e?.details);
  }

  /** legacy POST (no cookie). */
  private async post(path: string, envelope: unknown, timeoutMs: number, _unused: boolean): Promise<any> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DshNetworkError(`transport failure on ${path}: ${String(err)}`, err);
    }
    if (res.status === 415) {
      throw new DshNetworkError(`415 on ${path}: missing application/json content type`);
    }
    if (!res.ok) {
      throw new DshNetworkError(`HTTP ${res.status} on ${path}`);
    }
    try {
      return await res.json();
    } catch (err) {
      throw new DshNetworkError(`non-JSON response on ${path}`, err);
    }
  }

  private makeRpcId(): string {
    return `dsh-vscode-${Date.now().toString(36)}-${(this.nextId++).toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }
}

/** v012 session/list rows carry agentPreset only under
 *  projections.values.agentPreset; lift it so SessionRow readers see one shape. */
function normalizeSessionRow(item: any): any {
  if (!item || typeof item !== "object") return item;
  const values = item.projections?.values;
  const agentPreset = item.agentPreset ?? values?.agentPreset;
  return { ...item, agentPreset };
}
