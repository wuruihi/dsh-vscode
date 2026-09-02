/**
 * Protocol flavor detection (design.md §3.0).
 *
 * DSH 0.1.2 replaced the wire contract: slash-style endpoints with an {args}
 * envelope, one /api/remote.mux WebSocket, and token→cookie browser auth.
 * Legacy (0.1.1-rc.x) keeps dot-style endpoints, dual event sockets and no
 * auth. This module is the ONLY place that decides which flavor we are on;
 * everything downstream (client adapters, stream mode) keys off it.
 */

export type Flavor = "legacy" | "v012";

export interface Detection {
  flavor: Flavor;
  /** v012 server answered 401/403: flavor known, cookie exchange required
   *  before any /api call can succeed. */
  needsAuth: boolean;
}

/** Raw one-shot POST used only for probing (no RpcClient dependency — the
 *  client itself needs the flavor before it can route). */
async function probePost(baseUrl: string, method: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: any = undefined;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body is fine for probing */
  }
  return { status: res.status, json };
}

export function makeRpcId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Detect the server flavor. Try v012 first (its probe endpoint `session/list`
 * does not exist on legacy servers), then fall back to the legacy probe
 * (`session.list`; `host.describe` as a second chance for very old hosts).
 * A 401/403 on the v012 probe still identifies a 0.1.2+ server: it must
 * authenticate before answering.
 */
export async function detectFlavor(baseUrl: string, timeoutMs = 3000): Promise<Detection | undefined> {
  // 1. v012 probe: slash endpoint + {args} envelope.
  try {
    const { status, json } = await probePost(
      baseUrl,
      "session/list",
      { type: "client-request", rpcId: makeRpcId("probe"), method: "session/list", payload: { args: {} } },
      timeoutMs,
    );
    if (status === 401 || status === 403) return { flavor: "v012", needsAuth: true };
    if (status === 200) {
      if (json?.type === "server-response" && json?.result?.ok === true) return { flavor: "v012", needsAuth: false };
      // A well-formed server-response with a business error still proves the
      // endpoint exists (e.g. transient server-side failure): treat as v012.
      if (json?.type === "server-response") return { flavor: "v012", needsAuth: false };
    }
    // 404 / non-JSON / network-ish → not a 0.1.2 server at this URL.
  } catch {
    /* fall through to legacy */
  }

  // 2. Legacy probe: dot endpoint, direct payload.
  try {
    const { status, json } = await probePost(
      baseUrl,
      "session.list",
      { type: "client-request", rpcId: makeRpcId("probe"), method: "session.list", payload: {} },
      timeoutMs,
    );
    if (status === 200 && json?.type === "server-response") return { flavor: "legacy", needsAuth: false };
  } catch {
    /* unreachable */
  }
  try {
    const { status, json } = await probePost(
      baseUrl,
      "host.describe",
      { type: "client-request", rpcId: makeRpcId("probe"), method: "host.describe", payload: {} },
      timeoutMs,
    );
    if (status === 200 && json?.type === "server-response") return { flavor: "legacy", needsAuth: false };
  } catch {
    /* unreachable */
  }

  return undefined; // nothing answered in a shape we know — caller decides (banner, retry)
}
