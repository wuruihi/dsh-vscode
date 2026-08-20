/**
 * DSH RPC client: POST /api/<method> with the client-request envelope.
 * Approval/question answers go to POST /api/respond as client-response.
 *
 * Wire facts (dsh-host-apiproxy rpc.schema.js, rc.7):
 * - envelope: {type:"client-request", rpcId:string, method, payload}
 * - response: {type:"server-response", rpcId, result:{ok:true, value?} | {ok:false, error:{code,message,details}}}
 * - respond receipt: {accepted:true} | {accepted:false, reason:"not-pending"|"bad-response"}
 */

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

export class RpcClient {
  private nextId = 0;

  constructor(private readonly baseUrl: string) {}

  /** Unary RPC call. Throws DshRpcError (business) or DshNetworkError (transport). */
  async call<T = unknown>(method: string, payload: unknown, timeoutMs = 30_000): Promise<T> {
    const rpcId = this.makeRpcId();
    const envelope = { type: "client-request", rpcId, method, payload };
    const body = await this.post(`/api/${method}`, envelope, timeoutMs);
    if (body?.type !== "server-response" || body.rpcId !== rpcId) {
      throw new DshNetworkError(`unexpected response envelope for ${method}`);
    }
    const result = body.result;
    if (result && result.ok === true) return result.value as T;
    const e = result && result.ok === false ? result.error : undefined;
    throw new DshRpcError(e?.code ?? "internal", e?.message ?? `RPC ${method} failed`, e?.details);
  }

  /** Answer a pending approval/question. Returns the carrier receipt, never throws for business outcomes. */
  async respond(rpcId: string, value: unknown, timeoutMs = 30_000): Promise<RespondReceipt> {
    const envelope = { type: "client-response", rpcId, result: { ok: true, value } };
    try {
      const body = await this.post("/api/respond", envelope, timeoutMs);
      const r = body?.result?.value;
      if (r && typeof r === "object" && "accepted" in r) {
        return r as RespondReceipt;
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

  private makeRpcId(): string {
    return `dsh-vscode-${Date.now().toString(36)}-${(this.nextId++).toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`;
  }

  private async post(path: string, envelope: unknown, timeoutMs: number): Promise<any> {
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
}
