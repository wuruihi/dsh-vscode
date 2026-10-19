/**
 * which-port.cjs — print the base URL of the live DSH instance, discovered at
 * runtime (DSH 0.2.1+ assigns the desktop App's port on every launch).
 *
 * Used by docs/scripts so verification commands never hardcode a port:
 *   $u = node scripts/which-port.cjs ; node scripts/smoke.mjs --base-url $u --from-credentials
 *
 * Exit 1 when nothing answers (callers should treat that as "no instance").
 */
const { buildSync } = require("esbuild");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "which-port-"));
const stubDir = path.join(dir, "node_modules", "vscode");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(
  path.join(stubDir, "index.js"),
  "module.exports = { window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) } };\n",
);
const bundle = path.join(dir, "instances.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "connection", "instances.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: bundle,
  logLevel: "silent",
  external: ["vscode"],
});

(async () => {
  const { resolveInstance } = require(bundle);
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  const res = await resolveInstance({ home, timeoutMs: 3000 });
  if (!res.instance) {
    console.error("no running DSH instance answered (desktop App / legacy dsh web)");
    process.exitCode = 1;
    return;
  }
  console.log(res.instance.baseUrl);
})().finally(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
