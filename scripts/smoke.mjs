/**
 * Protocol smoke test against a running dsh web instance — flavor-aware
 * (design.md §3.0). Detects the wire generation first, then runs the matching
 * chain:
 *   legacy: host.describe, events.mux, session.*, session.history
 *   v012:   session/list, remote.mux open-stream, session/prompt(requestId),
 *           follow snapshot as history, modelCatalog
 * Exit 0 = PASS.
 *
 * Usage: node scripts/smoke.mjs [baseUrl] [--token <launchToken>]
 * Token fallback (v012): --token arg > DSH_SMOKE_TOKEN > ~/.dsh log scan.
 */
import WebSocket from "ws";
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const baseUrl = (argv.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:3080").replace(/\/+$/, "");
const tokenArg =
  argv[argv.indexOf("--token") + 1] && argv.indexOf("--token") !== -1
    ? argv[argv.indexOf("--token") + 1]
    : process.env.DSH_SMOKE_TOKEN;

const results = [];
let rpcSeq = 0;
let cookie = "";

function ok(name, cond, detail = "") {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const rpcId = () => `smoke-${Date.now().toString(36)}-${rpcSeq++}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- flavor detection (protocol.ts mirrored for standalone use) ----------

async function rawPost(method, body, timeoutMs = 3000) {
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    /* non-JSON is fine while probing */
  }
  return { status: res.status, json };
}

async function detectFlavor() {
  try {
    const { status, json } = await rawPost("session/list", {
      type: "client-request",
      rpcId: rpcId(),
      method: "session/list",
      payload: { args: {} },
    });
    if (status === 401 || status === 403) return { flavor: "v012", needsAuth: true };
    if (status === 200 && json?.type === "server-response") return { flavor: "v012", needsAuth: false };
  } catch {
    /* fall through */
  }
  try {
    const { status, json } = await rawPost("session.list", {
      type: "client-request",
      rpcId: rpcId(),
      method: "session.list",
      payload: {},
    });
    if (status === 200 && json?.type === "server-response") return { flavor: "legacy", needsAuth: false };
  } catch {
    /* unreachable */
  }
  try {
    const { status, json } = await rawPost("host.describe", {
      type: "client-request",
      rpcId: rpcId(),
      method: "host.describe",
      payload: {},
    });
    if (status === 200 && json?.type === "server-response") return { flavor: "legacy", needsAuth: false };
  } catch {
    /* unreachable */
  }
  return undefined;
}

// ---------- auth (v012) ----------

async function tokenFromLogTail(path, tailBytes = 262_144) {
  try {
    const info = await stat(path);
    const { open } = await import("node:fs/promises");
    const handle = await open(path, "r");
    try {
      const start = Math.max(0, info.size - tailBytes);
      const buf = Buffer.alloc(info.size - start);
      await handle.read(buf, 0, buf.length, start);
      const m = /token=([A-Za-z0-9_-]+)/.exec(buf.toString("utf8"));
      return m ? m[1] : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function discoverToken() {
  if (tokenArg) return tokenArg;
  const candidates = [join(homedir(), ".dsh", "dsh-vscode-web.log")];
  try {
    for (const dir of [join(homedir(), ".dsh", "logs"), join(homedir(), ".dsh")]) {
      const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".log"));
      const withTime = await Promise.all(
        names.map(async (n) => ({
          path: join(dir, n),
          mtime: (await stat(join(dir, n)).catch(() => undefined))?.mtimeMs ?? 0,
        })),
      );
      withTime.sort((a, b) => b.mtime - a.mtime);
      candidates.push(...withTime.map((x) => x.path));
    }
  } catch {
    /* best effort */
  }
  for (const file of candidates) {
    const token = await tokenFromLogTail(file);
    if (token) return token;
  }
  return undefined;
}

async function exchangeCookie(token) {
  try {
    const url = new URL("/", baseUrl);
    url.searchParams.set("token", token);
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      cookie = setCookie.split(";")[0].trim();
      return true;
    }
    return res.status === 200 || res.status === 302;
  } catch {
    return false;
  }
}

// ---------- RPC helpers ----------

async function call(method, payload, timeoutMs = 30_000, flavor = "legacy") {
  const envelope =
    flavor === "legacy"
      ? { type: "client-request", rpcId: rpcId(), method, payload }
      : { type: "client-request", rpcId: rpcId(), method, payload: { args: payload } };
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(envelope),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}`);
  const body = await res.json();
  if (body?.type !== "server-response" || body.rpcId !== envelope.rpcId) {
    throw new Error(`bad envelope on ${method}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const r = body.result;
  if (r?.ok === true) return r.value;
  throw new Error(`rpc error on ${method}: ${JSON.stringify(r?.error)}`);
}

// ---------- 0. detect ----------

let det = await detectFlavor();
if (!det) {
  console.error(`\nSMOKE FAILED: no recognizable DSH server at ${baseUrl}`);
  process.exit(1);
}
ok("detect flavor", true, `${det.flavor}${det.needsAuth ? " (auth required)" : ""}`);

if (det.flavor === "v012" && det.needsAuth) {
  const token = await discoverToken();
  if (!token) {
    ok("v012 auth", false, "no launch token (pass --token or set DSH_SMOKE_TOKEN)");
    process.exit(1);
  }
  const got = await exchangeCookie(token);
  ok("v012 auth", got);
  if (!got) process.exit(1);
  det = await detectFlavor();
}

// ============================================================ legacy chain
if (det.flavor === "legacy") {
  let describe;
  try {
    describe = await call("host.describe", {}, 3000);
    ok("host.describe", true);
  } catch (err) {
    ok("host.describe", false, String(err));
    console.error(`\nSMOKE FAILED: is dsh web running at ${baseUrl}?`);
    process.exit(1);
  }

  const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/events.mux";
  const ws = new WebSocket(wsUrl, { handshakeTimeout: 8000 });
  const frames = [];
  const waiters = [];
  ws.on("message", (data) => {
    const f = JSON.parse(data.toString("utf8"));
    frames.push(f);
    for (const w of waiters.splice(0)) w();
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("mux connect timeout")), 8000);
  }).catch((err) => {
    ok("events.mux connect", false, String(err));
    process.exit(1);
  });
  ok("events.mux connect", true);
  await sleep(300);
  const subCount = frames.filter((f) => f.payload?.type === "session/subscribed").length;
  ok("session/subscribed baseline frames", subCount > 0, `${subCount} frames`);

  const wsList = await call("workspace.list", {});
  ok("workspace.list", Array.isArray(wsList?.workspaces ?? wsList?.items ?? wsList), `shape: ${JSON.stringify(wsList).slice(0, 120)}`);

  const session = await call("session.create", { cwd: process.cwd() });
  const sessionId = session?.sessionId;
  ok("session.create(cwd)", typeof sessionId === "string" && sessionId.length > 0, sessionId);

  let assistantText = "";
  let sawTextDelta = false;
  let turnEnded = false;
  const turnDeadline = Date.now() + 90_000;
  await call("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: "请只回复两个字：收到" }],
    clientTimeZone: "Asia/Shanghai",
  });
  while (!turnEnded && Date.now() < turnDeadline) {
    await new Promise((r) => waiters.push(r));
    for (const f of frames.splice(0)) {
      const p = f.payload ?? {};
      if (p.type === "session/event" && p.sessionId === sessionId) {
        const ev = p.event ?? {};
        if (ev.type === "assistant/chunk") {
          const ch = ev.data?.chunk;
          if (ch?.type === "text-delta" && typeof ch.text === "string") {
            sawTextDelta = true;
            assistantText += ch.text;
          }
        } else if (ev.type === "turn/end") {
          turnEnded = true;
        }
      }
    }
  }
  ok("session.prompt accepted + stream text-delta", sawTextDelta, `text=${JSON.stringify(assistantText.slice(0, 40))}`);
  ok("turn/end within 90s", turnEnded);

  const history = await call("session.history", { sessionId, maxMessages: 10 });
  const histEvents = history?.events ?? [];
  const histHasTurn = histEvents.some((e) => e.event?.type === "turn/end");
  ok("session.history replay", histEvents.length > 0 && histHasTurn, `${histEvents.length} entries`);

  try {
    const renamed = await call("session.rename", { sessionId, title: "[smoke-test] 可删除" });
    ok("session.rename", typeof renamed?.title === "string");
  } catch (err) {
    ok("session.rename", false, String(err));
  }

  try {
    const models = await call("session.models", { sessionId });
    ok("session.models", typeof models?.current === "object" && Array.isArray(models?.groups));
  } catch (err) {
    ok("session.models", false, String(err));
  }

  ws.close();
} else {
  // ============================================================ v012 chain
  const wsUrl = baseUrl.replace(/^http/, "ws") + "/api/remote.mux";
  const ws = new WebSocket(wsUrl, { handshakeTimeout: 8000, headers: cookie ? { cookie } : {} });
  /** streamId → item queue */
  const streamItems = new Map();
  const waiters = [];
  let streamSeq = 0;
  ws.on("message", (data) => {
    const f = JSON.parse(data.toString("utf8"));
    if (f?.type === "item" || f?.type === "end" || f?.type === "error") {
      const q = streamItems.get(f.streamId) ?? [];
      q.push(f);
      streamItems.set(f.streamId, q);
    }
    for (const w of waiters.splice(0)) w();
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    setTimeout(() => reject(new Error("remote.mux connect timeout")), 8000);
  }).catch((err) => {
    ok("remote.mux connect", false, String(err));
    process.exit(1);
  });
  ok("remote.mux connect", true);

  function openStream(endpoint, args) {
    const streamId = `smoke-${++streamSeq}`;
    ws.send(JSON.stringify({ type: "open", streamId, endpoint, payload: { args } }));
    return streamId;
  }
  async function nextItem(streamId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const q = streamItems.get(streamId) ?? [];
      const f = q.shift();
      if (f) return f;
      if (Date.now() > deadline) return undefined;
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 200);
      });
    }
  }

  // $events ready
  const eventsId = openStream("$events", {});
  const readyFrame = await nextItem(eventsId, 8000);
  ok("$events ready (clientId)", readyFrame?.type === "item" && readyFrame.value?.type === "ready" && !!readyFrame.value?.clientId);

  // workspace/follow baseline
  const wsFollowId = openStream("workspace/follow", {});
  const wsBase = await nextItem(wsFollowId, 8000);
  const wsItems = wsBase?.value?.type === "baseline" ? (wsBase.value.value?.items ?? []) : [];
  ok("workspace/follow baseline", wsBase?.value?.type === "baseline", `${wsItems.length} workspaces`);

  // session/list (gateway wants the reserved _request param)
  const list = await call("session/list", { _request: {} }, 30_000, "v012");
  ok("session/list", Array.isArray(list?.items), `${list?.items?.length ?? 0} sessions`);

  // create + follow
  const session = await call("session/create", { request: { cwd: process.cwd() } }, 30_000, "v012");
  const sessionId = session?.sessionId;
  ok("session/create(cwd)", typeof sessionId === "string" && sessionId.length > 0, sessionId);

  const followId = openStream("session/follow", { request: { address: { kind: "session", sessionId } } });
  const snap = await nextItem(followId, 8000);
  ok(
    "session/follow snapshot",
    snap?.type === "item" && snap.value?.type === "snapshot" && Array.isArray(snap.value?.records),
    snap && snap.type !== "item" ? `frame=${JSON.stringify(snap).slice(0, 160)}` : "",
  );

  let assistantText = "";
  let sawChunk = false;
  let sawTextDelta = false;
  let turnEnded = false;
  const turnDeadline = Date.now() + 90_000;
  await call(
    "session/prompt",
    {
      request: {
        requestId: `smoke-${Date.now().toString(36)}`,
        sessionId,
        mode: "queue",
        content: [{ type: "text", text: "请只回复两个字：收到" }],
        clientTimeZone: "Asia/Shanghai",
      },
    },
    60_000,
    "v012",
  );
  while (!turnEnded && Date.now() < turnDeadline) {
    const f = await nextItem(followId, Math.max(500, turnDeadline - Date.now()));
    if (!f) break;
    if (f.type !== "item" || f.value?.type !== "event") continue;
    const ev = f.value.event ?? {};
    if (ev.type === "assistant/chunk") {
      const ch = ev.data?.chunk;
      sawChunk = true; // any chunk proves the follow stream carries assistant output
      if (ch?.type === "text-delta" && typeof ch.text === "string") {
        sawTextDelta = true;
        assistantText += ch.text;
      }
    } else if (ev.type === "turn/end") {
      turnEnded = true;
    }
  }
  // An isolated test server may have no model credentials: a finish-chunk
  // (even an error finish) still proves the streaming path end to end.
  ok("session/prompt(requestId) + follow chunk stream", sawChunk, sawTextDelta ? `text=${JSON.stringify(assistantText.slice(0, 40))}` : "chunks streamed (no text: server has no model key)");
  ok("turn/end within 90s", turnEnded);

  // modelCatalog
  try {
    const cat = await call("session/modelCatalog", {}, 30_000, "v012");
    ok("session/modelCatalog", typeof cat?.default === "object" || Array.isArray(cat?.groups));
  } catch (err) {
    ok("session/modelCatalog", false, String(err));
  }

  // rename
  try {
    const renamed = await call("session/rename", { request: { sessionId, title: "[smoke-test] 可删除" } }, 30_000, "v012");
    ok("session/rename", typeof renamed?.title === "string");
  } catch (err) {
    ok("session/rename", false, String(err));
  }

  ws.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== SMOKE ${failed.length === 0 ? "PASSED" : "FAILED"}: ${results.length - failed.length}/${results.length} ===`);
process.exit(failed.length === 0 ? 0 : 1);
