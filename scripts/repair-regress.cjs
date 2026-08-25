const fs = require("node:fs");
const path = require("node:path");
const ts = require(path.join("D:/repos/dsh-vscode/node_modules/typescript/lib/typescript.js"));
const src = fs.readFileSync("D:/repos/dsh-vscode/webview/src/components/dshui.tsx", "utf8");
const body = src.slice(src.indexOf("type Node"), src.indexOf("export function DshUi"));
const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
const parseSpec = new Function(`${js}\nreturn parseSpec;`)();

// user's exact payload, VERBATIM (ends ]]} — items array closed by root's })
const userRaw = `{"gap":12,"items":[{"type":"callout","tone":"warning","title":"为什么你会看不到","content":"当前代码的 /upload 页有「资金流」常驻入口（带徽标）。你看到只有线上/线下两个入口，是改版前打开的旧标签页——今天的改动靠 HMR 推送，断连后页面停在旧版。刷新一下就是新的。"},"type":"table","columns":["顺手修的问题","改动"],"rows":[["入口位置太深","新「资金流」区块原来排在页面最底部（被骗方式之后），确实容易漏看 → 上移到紧跟「受害人信息」，与 PC 端顺序一致（基本信息→资金流）"],["小程序没演示双轨","原来种子只有新资金流数据，旧结构永远不显示 → 补 1 条线上转账(28000)+1 条线下送现(20000)，历史警情双轨形态在小程序也能演示；被骗金额联动 128000"],["旧页面还带新增按钮","线上转账/线下送现旧页面仍有「添加」入口，违反定版规则（旧模块只改只删）→ 已隐藏，加「历史数据·不提供新增」横幅"]]}`;

const balanced = `{"gap":12,"items":[{"type":"callout","content":"c"},"type":"table","columns":["a","b"],"rows":[["x","y"]]]}`;

const cases = [
  ["user verbatim (bare pairs + early root close)", userRaw, (v) => v.items.length === 2 && v.items[1].type === "table" && v.items[1].rows.length === 3 && v.gap === 12],
  ["balanced bare pairs", balanced, (v) => v.items.length === 2 && v.items[1].type === "table"],
  ["valid untouched", `{"items":[{"type":"text","content":"a"}],"gap":8}`, (v) => v.items[0].content === "a"],
  ["bare component seq (historical)", `{"type": "button", "label": "A"}\n{"type": "button", "label": "B"}`, (v) => v.items.length === 2],
  ["early root close, items dangling (historical)", `{"items": [{"type": "text", "content": "x"}}`, (v) => v.items.length === 1],
  ["trailing prose (historical)", `{"items": [{"type": "text", "content": "x"}]}\n\n正文说明`, (v) => v.items.length === 1],
];

let pass = 0;
for (const [name, input, check] of cases) {
  try {
    const v = parseSpec(input);
    const ok = v ? check(v) : false;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
    if (ok) pass++;
    else console.log("   got:", JSON.stringify(v)?.slice(0, 120));
  } catch (e) {
    console.log(`ERROR ${name}: ${e.message}`);
  }
}
console.log(`${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
