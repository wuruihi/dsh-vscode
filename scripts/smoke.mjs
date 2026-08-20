/**
 * Protocol smoke test against a running dsh web instance.
 * Verifies: envelope round-trip, workspace.list, session.create(cwd),
 * events.mux subscription + filtering, session.prompt, streamed text-delta,
 * turn/end, session.rename. Exit 0 = PASS.
 *
 * Usage: node scripts/smoke.mjs [baseUrl]
 */
import WebSocket from "ws";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:3080";
const results = [];
let rpcSeq = 0;

function ok(name, cond, detail = "") {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function call(method, payload, timeoutMs = 30000) {
  const rpcId = `smoke-${Date.now().toString(36)}-${rpcSeq++}`;
  const res = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${method}`);
  const body = await res.json();
  if (body?.type !== "server-response" || body.rpcId !== rpcId) {
    throw new Error(`bad envelope on ${method}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const r = body.result;
  if (r?.ok === true) return r.value;
  throw new Error(`rpc error on ${method}: ${JSON.stringify(r?.error)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 1. probe ---
let describe;
try {
  describe = await call("host.describe", {}, 3000);
  ok("host.describe", true);
} catch (err) {
  ok("host.describe", false, String(err));
  console.error(`\nSMOKE FAILED: is dsh web running at ${baseUrl}?`);
  process.exit(1);
}

// --- 2. connect mux stream ---
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
await sleep(300); // let subscribe frames arrive
const subCount = frames.filter((f) => f.payload?.type === "session/subscribed").length;
ok("session/subscribed baseline frames", subCount > 0, `${subCount} frames`);

// --- 3. workspace.list ---
const wsList = await call("workspace.list", {});
ok("workspace.list", Array.isArray(wsList?.workspaces ?? wsList?.items ?? wsList), `shape: ${JSON.stringify(wsList).slice(0, 120)}`);

// --- 4. create session ---
const session = await call("session.create", { cwd: process.cwd() });
const sessionId = session?.sessionId;
ok("session.create(cwd)", typeof sessionId === "string" && sessionId.length > 0, sessionId);

// --- 5. prompt + stream ---
let assistantText = "";
let sawTextDelta = false;
let sawToolCall = false;
let turnEnded = false;
const targetFrames = [];
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
      targetFrames.push(p);
      const ev = p.event ?? {};
      if (ev.type === "assistant/chunk") {
        const ch = ev.data?.chunk;
        if (ch?.type === "text-delta" && typeof ch.text === "string") {
          sawTextDelta = true;
          assistantText += ch.text;
        }
        if (ch?.type === "tool-call") sawToolCall = true;
      } else if (ev.type === "tool/call") {
        sawToolCall = true;
      } else if (ev.type === "turn/end") {
        turnEnded = true;
      }
    }
  }
}
ok("session.prompt accepted + stream text-delta", sawTextDelta, `text=${JSON.stringify(assistantText.slice(0, 40))}`);
ok("turn/end within 90s", turnEnded);

// --- 6. history replay ---
const history = await call("session.history", { sessionId, maxMessages: 10 });
const histEvents = history?.events ?? [];
const histHasTurn = histEvents.some((e) => e.event?.type === "turn/end");
ok("session.history replay", histEvents.length > 0 && histHasTurn, `${histEvents.length} entries`);

// --- 7. rename ---
try {
  const renamed = await call("session.rename", { sessionId, title: "[smoke-test] 可删除" });
  ok("session.rename", typeof renamed?.title === "string");
} catch (err) {
  ok("session.rename", false, String(err));
}

// --- 8. models ---
try {
  const models = await call("session.models", { sessionId });
  ok("session.models", typeof models?.current === "object" && Array.isArray(models?.groups));
} catch (err) {
  ok("session.models", false, String(err));
}

ws.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n=== SMOKE ${failed.length === 0 ? "PASSED" : "FAILED"}: ${results.length - failed.length}/${results.length} ===`);
process.exit(failed.length === 0 ? 0 : 1);
