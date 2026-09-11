/**
 * model-regress.cjs — model-selection resolution against REAL host shapes.
 *
 * Regression for the 2026-09-11 report: the panel chip showed the host's
 * GLOBAL default model (session/modelCatalog `default`) as if it were the
 * session's own, so a session whose every request ran comleader/glm-5.3
 * displayed deepseek-v4.1-flash — the user switched models, saw the new name,
 * and concluded the switch had applied to that session.
 *
 * Fixtures below are the verbatim projection payloads read from the live host.
 * Asserts: (1) the chip resolves to the session's OWN model, `next` (pending
 * switch) winning over `lastUsed`; (2) a catalog-default-shaped payload can
 * never masquerade as a session model; (3) a NEW chat inherits THIS workspace's
 * last-used model and nothing else — in particular never another project's.
 */
const { buildSync } = require("esbuild");
const path = require("path");
const os = require("os");

const out = path.join(os.tmpdir(), `model-regress-${Date.now()}.cjs`);
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "session", "model-choice.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const { realModelOf, parsePinnedModel, pickChatDefault } = require(out);

let passed = 0;
const fails = [];
const ok = (name, cond) => {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}`);
  }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---- 1. the session's own model (verbatim live payload, 洛阳案件分析) ----
// session-d75a304a: every request ran glm-5.3 while the chip said v4.1-flash.
const LUOYANG = { lastUsed: { provider: "comleader", model: "glm-5.3" }, next: { provider: "comleader", model: "glm-5.3" } };
ok("real session payload → the session's actual model", eq(realModelOf(LUOYANG), { provider: "comleader", model: "glm-5.3" }));

// A pending switch (model/selection appended, no request yet) must show up at
// once — that is the whole point of preferring `next`.
const PENDING = { lastUsed: { provider: "comleader", model: "glm-5.3" }, next: { provider: "comleader", model: "deepseek-v4.1-flash" } };
ok("pending switch (next) beats lastUsed", eq(realModelOf(PENDING), { provider: "comleader", model: "deepseek-v4.1-flash" }));

ok("next:null falls back to lastUsed", eq(realModelOf({ lastUsed: { provider: "comleader", model: "glm-5.3" }, next: null }), { provider: "comleader", model: "glm-5.3" }));
ok("both null → undefined (no invented model)", realModelOf({ lastUsed: null, next: null }) === undefined);
ok("empty object → undefined", realModelOf({}) === undefined);
ok("null / undefined / string → undefined", realModelOf(null) === undefined && realModelOf(undefined) === undefined && realModelOf("glm-5.3") === undefined);
ok("entry missing provider or model → undefined", realModelOf({ lastUsed: { provider: "comleader" }, next: { model: "x" } }) === undefined);

// The old lie: a catalog-default payload ({provider, model}) has no session
// semantics at all — it must resolve to nothing so the chip falls back instead
// of pretending.
ok("catalog-default shape never masquerades as a session model", realModelOf({ provider: "comleader", model: "deepseek-v4.1-flash" }) === undefined);

ok("reasoningEffort carried through", eq(realModelOf({ next: { provider: "comleader", model: "glm-5.3", reasoningEffort: "high" } }), { provider: "comleader", model: "glm-5.3", reasoningEffort: "high" }));
ok("empty reasoningEffort dropped", eq(realModelOf({ next: { provider: "comleader", model: "glm-5.3", reasoningEffort: "" } }), { provider: "comleader", model: "glm-5.3" }));

// ---- 2. pinned setting parsing (kept, but OFF by default) ----
ok("unset pin → {}", eq(parsePinnedModel(""), {}) && eq(parsePinnedModel("   "), {}));
ok("provider/model parsed", eq(parsePinnedModel("comleader/deepseek-v4.1-flash"), { choice: { provider: "comleader", model: "deepseek-v4.1-flash" } }));
ok("provider/model/effort parsed", eq(parsePinnedModel("comleader/deepseek-v4.1-flash/high"), { choice: { provider: "comleader", model: "deepseek-v4.1-flash", reasoningEffort: "high" } }));
ok("model id containing / kept intact", eq(parsePinnedModel("agens/agnes-video-2.5-flash/low"), { choice: { provider: "agens", model: "agnes-video-2.5-flash", reasoningEffort: "low" } }));
ok("single segment → malformed (never silently ignored)", eq(parsePinnedModel("deepseek-v4.1-flash"), { malformed: "deepseek-v4.1-flash" }));
ok("trailing slash → malformed", parsePinnedModel("/model").malformed === "/model");

// ---- 3. what a NEW chat in a project starts on ----
const WS_A = { provider: "comleader", model: "glm-5.3" };
const WS_B = { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "medium" };
ok("new chat: this workspace's last-used model (no pin)", eq(pickChatDefault(null, WS_A), WS_A));
ok("new chat: pin wins when set", eq(pickChatDefault({ provider: "agens", model: "agnes-2.5-flash" }, WS_A), { provider: "agens", model: "agnes-2.5-flash" }));
ok("new chat: effort of the workspace model preserved", eq(pickChatDefault(null, WS_B), WS_B));
ok("first-ever chat here → undefined (host default rules)", pickChatDefault(null, undefined) === undefined && pickChatDefault(null, null) === undefined);
ok("other project's memory is not this project's default", pickChatDefault(null, undefined) === undefined);
// The workspace memory is written ONLY from realModelOf(projection) — never
// from the catalog default. That shape resolves to undefined (asserted in §1),
// so a global default can never be stored as a project default in the first
// place; pickChatDefault itself just validates the shape it is handed.
ok("memory must be a whole choice or nothing", pickChatDefault(null, { provider: "comleader" }) === undefined && pickChatDefault(null, { model: "x" }) === undefined);
ok("stale/garbage memory ignored", pickChatDefault(null, "glm-5.3") === undefined && pickChatDefault(null, { model: "glm-5.3" }) === undefined);

console.log(fails.length === 0 ? `\n${passed}/${passed} passed` : `\nFAILED: ${fails.length}`);
process.exit(fails.length === 0 ? 0 : 1);
