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
 * Token fallback (v012): --token arg > DSH_SMOKE_TOKEN > log scan (newest file
 * first: ~/.dsh/dsh-vscode-web.log, ~/.dsh[/logs], ~/dsh/logs, plus whatever
 * DSH_SMOKE_LOG names). Candidates are tried newest-first until one mints a
 * cookie.
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

// Sessions created by this run — the teardown at the bottom archives them and
// deletes their files. DSH has no session-delete API, so a smoke run that skips
// this leaves "[smoke-test] 可删除" sessions in the sidebar permanently.
const smokeSessionIds = [];

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

/** Launch tokens in a log file, NEWEST first. `dsh web` prints a fresh token on
 *  every start, and a log can hold several starts (the local launcher archives
 *  per start, some installs append) — reading the first match would replay a
 *  stale token and fail the cookie exchange for a reason that looks like a
 *  protocol break. */
async function tokensFromLog(path, tailBytes = 262_144) {
  try {
    const info = await stat(path);
    const { open } = await import("node:fs/promises");
    const handle = await open(path, "r");
    try {
      const start = Math.max(0, info.size - tailBytes);
      const buf = Buffer.alloc(info.size - start);
      await handle.read(buf, 0, buf.length, start);
      return [...buf.toString("utf8").matchAll(/token=([A-Za-z0-9_-]+)/g)].map((m) => m[1]).reverse();
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

/** Log files that may carry a launch token, newest first. Covers both start
 *  paths: the log this extension's own auto-start writes (~/.dsh) and the
 *  conventional local deployment dir (~/dsh/logs) used by a desktop-shortcut
 *  launcher — a layout convention, never a hardcoded user name (2026-09-17:
 *  the token lived in <install>/logs, which this scan never looked at, so the
 *  whole v012 chain aborted here). DSH_SMOKE_LOG adds a file or directory. */
async function tokenCandidateFiles() {
  const home = homedir();
  const named = [join(home, ".dsh", "dsh-vscode-web.log")];
  const dirs = [join(home, ".dsh", "logs"), join(home, ".dsh"), join(home, "dsh", "logs")];
  const extra = (process.env.DSH_SMOKE_LOG ?? "").trim();
  if (extra) {
    const st = await stat(extra).catch(() => undefined);
    if (st?.isFile()) named.push(extra);
    else dirs.push(extra);
  }
  const found = new Map(); // path -> mtimeMs
  for (const f of named) {
    const st = await stat(f).catch(() => undefined);
    if (st?.isFile()) found.set(f, st.mtimeMs);
  }
  for (const dir of dirs) {
    const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith(".log"));
    for (const n of names) {
      const p = join(dir, n);
      const st = await stat(p).catch(() => undefined);
      if (st?.isFile()) found.set(p, st.mtimeMs);
    }
  }
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

/** Every distinct token found, newest file first. */
async function discoverTokens() {
  if (tokenArg) return [tokenArg];
  const seen = new Set();
  const out = [];
  for (const file of await tokenCandidateFiles()) {
    for (const t of await tokensFromLog(file)) {
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  }
  return out;
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
  const tokens = await discoverTokens();
  if (tokens.length === 0) {
    ok("v012 auth", false, "no launch token (pass --token, set DSH_SMOKE_TOKEN, or point DSH_SMOKE_LOG at the dsh web log)");
    process.exit(1);
  }
  // Try the candidates newest-first. A token that mints a real cookie wins
  // outright; a bare 200/302 (the old acceptance rule) is only a fallback, so a
  // stale token can never cut the search short.
  let got = false;
  let used = 0;
  let fallback = 0;
  for (const [i, t] of tokens.entries()) {
    const accepted = await exchangeCookie(t);
    if (accepted && cookie) {
      got = true;
      used = i + 1;
      break;
    }
    if (accepted && fallback === 0) fallback = i + 1;
  }
  if (!got && fallback > 0) {
    got = true;
    used = fallback;
  }
  const detail = got
    ? tokens.length > 1
      ? `cookie minted with token ${used}/${tokens.length} from the log candidates`
      : ""
    : `none of the ${tokens.length} launch token(s) found in the logs were accepted`;
  ok("v012 auth", got, detail);
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
  if (typeof sessionId === "string" && sessionId) smokeSessionIds.push(sessionId);

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
  if (typeof sessionId === "string" && sessionId) smokeSessionIds.push(sessionId);

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

// ---------- teardown: smoke sessions leave no residue ----------
// Archive hides a session from the sidebar; deleting the files is what actually
// removes it (DSH has no session-delete API). Both run best-effort: a cleanup
// failure must not turn a passing smoke run red.
if (smokeSessionIds.length > 0) {
  const { logDirOf, purgeSessionFiles } = await import("./session-purge.mjs");
  let removedCount = 0;
  for (const sid of smokeSessionIds) {
    try {
      await call("workspace/archiveSession", { sessionId: sid }, 15_000, "v012");
    } catch {
      /* legacy host, or already archived — the file cleanup below still applies */
    }
    removedCount += purgeSessionFiles(sid).length;
  }
  ok(
    "teardown: smoke sessions archived + files deleted (no residue)",
    smokeSessionIds.every((sid) => logDirOf(sid) === null),
    `${smokeSessionIds.length} session(s), ${removedCount} path(s) removed`,
  );
}

const failed = results.filter((r) => !r.pass);
console.log(`\n=== SMOKE ${failed.length === 0 ? "PASSED" : "FAILED"}: ${results.length - failed.length}/${results.length} ===`);
process.exit(failed.length === 0 ? 0 : 1);
