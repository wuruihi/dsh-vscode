/**
 * fold-live.cjs — replay a REAL session's history through ConversationFold
 * and dump what the renderer would show. Usage:
 *   node scripts/fold-live.cjs [sessionId?] [tailEvents?=120]
 * Minted-cookie auth (browser-auth), read-only session/history call.
 */
const { buildSync } = require("esbuild");
const path = require("path");
const os = require("os");

const tmp = (n) => path.join(os.tmpdir(), `${n}-${Date.now()}.cjs`);
const authOut = tmp("ba");
const foldOut = tmp("fd");
buildSync({ entryPoints: [path.join(__dirname, "..", "src", "connection", "browser-auth.ts")], bundle: true, format: "cjs", platform: "node", outfile: authOut, logLevel: "silent" });
buildSync({ entryPoints: [path.join(__dirname, "..", "webview", "src", "fold.ts")], bundle: true, format: "cjs", platform: "node", outfile: foldOut, logLevel: "silent" });
const { mintFromCredentialsFile } = require(authOut);
const { ConversationFold } = require(foldOut);

const target = "http://127.0.0.1:3080";
const sidWanted = process.argv[2];
const tail = parseInt(process.argv[3] ?? "120", 10);

async function call(method, args) {
  const cookie = await mintFromCredentialsFile(target, path.join(os.homedir(), ".dsh", ".credentials.yaml"));
  const res = await fetch(`${target}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ type: "client-request", rpcId: "fl" + Math.random().toString(36).slice(2), method, payload: { args } }),
  });
  const b = await res.json();
  if (!b.result?.ok) throw new Error(method + ": " + JSON.stringify(b.result?.error).slice(0, 160));
  return b.result.value;
}

(async () => {
  let sid = sidWanted;
  if (!sid) {
    const list = await call("session/list", { _request: {} });
    const items = (list.items ?? []).slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    sid = items[0]?.sessionId;
    console.log("newest session:", sid, items[0]?.projections?.values?.title ?? "");
  }
  const hist = await call("session/page", { request: { address: { kind: "session", sessionId: sid }, throughSeq: 145709, maxMessages: 100000 } });
  const events = (hist.records ?? []).map((r) => ({ event: r?.event, view: r?.view }));
  console.log("history events:", events.length);
  const types = {};
  for (const e of events) types[e.event?.type ?? e.type] = (types[e.event?.type ?? e.type] ?? 0) + 1;
  console.log("types:", JSON.stringify(types));

  const fold = new ConversationFold();
  fold.pushMany(events);
  const turns = fold.items.filter((i) => i.kind === "turn");
  const last = turns[turns.length - 1];
  console.log("\nitems:", fold.items.length, "turns:", turns.length);
  if (last) {
    console.log("last turn ended:", last.ended, "activities:", last.activities.length, "segs:", last.segments.length);
    console.log("flat text tail:", JSON.stringify((last.text ?? "").slice(-60)));
    console.log("segments:");
    last.segments.forEach((s, i) => {
      if (s.kind === "tool") console.log(`  [${i}] tool ${s.act.label} (${s.act.state})`);
      else console.log(`  [${i}] ${s.kind} ${JSON.stringify((s.text ?? "").slice(0, 50))}`);
    });
  }
  // raw tail event types for cross-check
  console.log("\nraw tail events:");
  for (const e of events.slice(-tail)) {
    const t = e.event?.type ?? e.type;
    const d = e.event?.data ?? e.data ?? {};
    const extra = d.chunk?.type ?? d.message?.content?.[0]?.type ?? d.name ?? "";
    console.log(`  ${t} ${extra}`.trimEnd());
  }
})().catch((e) => {
  console.error("ERROR", e.message);
  process.exit(1);
});
