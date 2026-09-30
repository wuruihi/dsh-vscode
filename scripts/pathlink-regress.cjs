/**
 * pathlink-regress.cjs — inline-code path detection (需求三第一批 C3).
 *
 * Extraction follows fence-regress.cjs: transpile ONE function out of the
 * renderer and drive it directly, so the regression cannot drift from the
 * code that ships. The risky half of C3 is false positives (a URL or a version
 * number becoming a clickable "file"), hence the negative cases.
 */
const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.join(__dirname, "..");
const ts = require(path.join(ROOT, "node_modules/typescript/lib/typescript.js"));
const src = fs.readFileSync(path.join(ROOT, "webview/src/components/markdown.tsx"), "utf8");
const fn = /export function pathInInlineCode[\s\S]*?\n\}/.exec(src)[0].replace(/^export /, "");
const js = ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const pathInInlineCode = new Function(`${js}\nreturn pathInInlineCode;`)();

const cases = [
  ["windows absolute path", "D:\\03-Projects\\Plugins\\dsh-vscode\\src\\fold.ts", "D:\\03-Projects\\Plugins\\dsh-vscode\\src\\fold.ts"],
  ["posix relative path", "webview/src/components/markdown.tsx", "webview/src/components/markdown.tsx"],
  ["CJK segment path", "workspace/深海反诈平台/20260930-PRD-预警.md", "workspace/深海反诈平台/20260930-PRD-预警.md"],
  ["dot-slash relative", "./memory/rules_general.md", "./memory/rules_general.md"],
  ["url rejected", "https://x.com/a.md", undefined],
  ["bare version rejected", "1.2.3", undefined],
  ["identifier rejected", "array.map", undefined],
  ["plain word rejected", "总结一下", undefined],
];

let pass = 0;
for (const [name, input, want] of cases) {
  const got = pathInInlineCode(input);
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(got)}`);
  if (ok) pass++;
}
console.log(`${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);