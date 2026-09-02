/**
 * auth-regress.cjs — browser-cookie minting against the REAL wire.
 *
 * Bundles browser-auth.ts (pure node) and checks against a live v012
 * server (default http://127.0.0.1:3080, override via DSH_AUTH_TARGET):
 *  1. mint from ~/.dsh/.credentials.yaml authenticates /api/session/list
 *     (read-only probe) — proves the zero-config, restart-proof path;
 *  2. a tampered secret is rejected with 401 — proves we are not just
 *     hitting an open server.
 * Skips (exit 0, marked SKIP) when no server or no credentials record —
 * this is a live-integration check, not a fixture test.
 */
const { buildSync } = require("esbuild");
const path = require("path");
const os = require("os");

const out = path.join(os.tmpdir(), `browser-auth-regress-${Date.now()}.cjs`);
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "connection", "browser-auth.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const { mintFromCredentialsFile, mintBrowserCookie, authorityOf, readBrowserSecret } = require(out);

const target = process.env.DSH_AUTH_TARGET ?? "http://127.0.0.1:3080";
const credentialsPath = path.join(os.homedir(), ".dsh", ".credentials.yaml");

async function probe(cookie) {
  const res = await fetch(`${target}/api/session/list`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ type: "client-request", rpcId: "auth-regress", method: "session/list", payload: { args: { _request: {} } } }),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status !== 200) return { status: res.status };
  const body = await res.json();
  return { status: 200, count: body?.result?.value?.items?.length };
}

(async () => {
  const secret = await readBrowserSecret(credentialsPath);
  const serverUp = await fetch(target).then((r) => r.status > 0).catch(() => false);
  if (!secret || !serverUp) {
    console.log(`SKIP  live server=${serverUp} credentials=${!!secret}`);
    process.exit(0);
  }
  const fails = [];
  const ok = (name, cond) => console.log(`${cond ? "PASS" : "FAIL"}  ${name}`) || (cond ? 0 : fails.push(name));

  // 1. real mint authenticates
  const cookie = await mintFromCredentialsFile(target, credentialsPath);
  ok("minted cookie authenticates session/list", !!cookie);
  if (cookie) {
    const r = await probe(cookie);
    ok(`server accepts minted cookie (sessions=${r.count})`, r.status === 200 && typeof r.count === "number");
  }

  // 2. tampered secret rejected
  const bad = Buffer.from("A".repeat(43, "utf8"), "utf8");
  const tampered = mintBrowserCookie(authorityOf(target), bad.slice(0, 32));
  const r2 = await probe(`${tampered.name}=${tampered.value}`);
  ok("tampered secret rejected (401)", r2.status === 401);

  console.log(fails.length === 0 ? "\nall passed" : `\nFAILED: ${fails.length}`);
  process.exit(fails.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error("ERROR", e.message);
  process.exit(1);
});
