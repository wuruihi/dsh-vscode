const fs = require("node:fs");
const path = require("node:path");
const ts = require(path.join("D:/repos/dsh-vscode/node_modules/typescript/lib/typescript.js"));
const src = fs.readFileSync("D:/repos/dsh-vscode/webview/src/components/Markdown.tsx", "utf8");
const fnSplit = /function splitDshUiSegments[\s\S]*?\n\}/.exec(src)[0];
const fnStart = /function specStart[\s\S]*?\n\}/.exec(src)[0];
const fnBal = /function balancedEnd[\s\S]*?\n\}/.exec(src)[0];
const js = ts.transpileModule(`${fnStart}\n${fnBal}\n${fnSplit}`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const split = new Function("text", `${js}\nreturn splitDshUiSegments(text);`);

const cases = [
  ["glued opener", "前文。一句话主线。```dsh-ui\n{\"items\": [{\"type\": \"text\", \"content\": \"a\"}]}\n```\n后文正文。", (s) => s.filter(x => x.kind === "fence").length === 1 && s.some(t => t.kind === "text" && t.text.includes("前文")) && s.some(t => t.kind === "text" && t.text.includes("后文正文"))],
  ["missing closer + prose", "按消化规则。```dsh-ui\n{\"items\": [{\"type\": \"callout\", \"content\": \"x\"}], \"gap\": 14}\n\n补充说明自由组合。\n\n以上", (s) => s.filter(x => x.kind === "fence").length === 1 && s.some(t => t.kind === "text" && t.text.includes("补充说明"))],
  ["bare components", "```dsh-ui\n{\"type\": \"button\", \"label\": \"A\"}\n{\"type\": \"button\", \"label\": \"B\"}\n```", (s) => s.filter(x => x.kind === "fence").length === 1],
  ["early-close + orphans", "```dsh-ui\n{\"items\": [{\"type\": \"text\", \"content\": \"x\"}]}},{\"type\": \"text\", \"content\": \"y\"}\n```", (s) => s.filter(x => x.kind === "fence").length === 1],
  ["plain fence hides literal", "```js\nvar s = \"```dsh-ui\";\n```\nreal prose", (s) => s.filter(x => x.kind === "fence").length === 0 && s.some(t => t.kind === "text" && t.text.includes("real prose"))],
  ["streaming partial", "正文\n```dsh-ui\n{\"items\": [{\"type\": \"text\", \"content\": \"半截", (s) => s.filter(x => x.kind === "fence").length === 1 && s.filter(x => x.kind === "text").length === 1],
  ["two clean fences", "a\n\n```dsh-ui\n{\"items\": [{\"type\": \"text\", \"content\": \"1\"}]}\n```\n\nb\n\n```dsh-ui\n{\"items\": [{\"type\": \"text\", \"content\": \"2\"}]}\n```\n\nc", (s) => s.filter(x => x.kind === "fence").length === 2],
  ["user exact 3.3 case", "3.3 拆给你听。\n\n一句话主线：时机完全不同。```dsh-ui\n{\"title\": \"3.3 到底在说什么\", \"gap\": 14, \"items\": [{\"type\": \"text\", \"size\": \"h3\", \"content\": \"第一件\"}, {\"type\": \"timeline\", \"items\": [{\"time\": \"2025-01\", \"title\": \"常住人口登记\", \"desc\": \"张三\"}]}]}\n\n\n剩下两条小规则补一句就通：\n\n- **时间打平**：标待核实\n\n以上", (s) => s.filter(x => x.kind === "fence").length === 1 && s.some(t => t.kind === "text" && t.text.includes("剩下两条小规则"))],
];
let pass = 0;
for (const [name, input, check] of cases) {
  try {
    const segs = split(input);
    const ok = check(segs);
    console.log(`${ok ? "PASS" : "FAIL"} ${name} -> ${segs.map(s => s.kind + "(" + s.text.length + "ch)").join(", ")}`);
    if (ok) pass++;
  } catch (e) {
    console.log(`ERROR ${name}: ${e.message}`);
  }
}
console.log(`${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
