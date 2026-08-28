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
  ["unescaped inner quotes (host GUI xn parity)", `{"items": [{"type": "text", "content": "他说"你好"然后走了"}]}`, (v) => v.items[0].content === `他说"你好"然后走了`],
  ["trailing comma (host GUI xn parity)", `{"items": [{"type": "text", "content": "a"},],}`, (v) => v.items.length === 1],
  ["bare component root, valid JSON (badcase 6 verbatim)", `{
  "type": "file-tree",
  "items": [
    {
      "name": "技术反制",
      "type": "dir",
      "children": [
        {
          "name": "资金账户反制",
          "type": "dir",
          "children": [
            {
              "name": "接警止付（页签：银行卡止付 / 第三方止付 / 流水号止付）",
              "type": "dir",
              "children": [
                {
                  "name": "警单列表→止付账号列表，对接国反平台（RPA），批量止付需同类型",
                  "type": "file"
                }
              ]
            },
            {
              "name": "资金止付（原受害人止付）",
              "type": "dir",
              "children": [
                {
                  "name": "国反平台止付（页签：待止付/待反馈/止付失败/已止付/全部）",
                  "type": "dir",
                  "children": [
                    {
                      "name": "资金预警自动生成卡级任务，循环止付，无需审批",
                      "type": "file"
                    }
                  ]
                },
                {
                  "name": "人行渠道止付（原手动止付数据，字段调整）",
                  "type": "dir",
                  "children": [
                    {
                      "name": "资金预警推送的人员级止付，一次推送默认15天，支持解除，有审核状态",
                      "type": "file"
                    }
                  ]
                },
                {
                  "name": "受害人银行卡库",
                  "type": "file"
                }
              ]
            },
            {
              "name": "手动止付（重构：省厅4手段）",
              "type": "dir",
              "children": [
                {
                  "name": "只收不付/不收不付/限额管控/限非 → 人员级表单，提交→分局→市局审批→推送省厅",
                  "type": "file"
                }
              ]
            }
          ]
        },
        {
          "name": "通信渠道反制",
          "type": "dir",
          "children": [
            {
              "name": "涉诈号码反制（待反制/反制详单/命中白名单）",
              "type": "file"
            },
            {
              "name": "涉诈网址反制",
              "type": "file"
            },
            {
              "name": "受害人号码反制",
              "type": "file"
            },
            {
              "name": "手动反制",
              "type": "file"
            }
          ]
        },
        {
          "name": "反制策略管理",
          "type": "file"
        },
        {
          "name": "反制函件管理",
          "type": "file"
        },
        {
          "name": "反制白名单",
          "type": "file"
        },
        {
          "name": "流程审批中心（通信渠道/资金账户子菜单）",
          "type": "file"
        }
      ]
    }
  ]
}`, (v) => v.items[0].type === "file-tree" && v.items[0].items[0].name === "技术反制" && v.items[0].items[0].children[0].children[1].children[2].name === "受害人银行卡库"],
  ["bare component array root, valid JSON", `[{"type":"text","content":"a"},{"type":"badge","label":"b"}]`, (v) => v.items.length === 2 && v.items[1].type === "badge"],
  ["bare string array still rejected (no unambiguous intent)", `["a","b"]`, "reject"],
  ["bare callout root, type lost (badcase 7 verbatim)", `{"title":"核心判断","tone":"info","content":"当年建应用集成平台，是因为真合并太贵，结果只统一了门、没统一房子——客户看到的是一扇门，研发盖的还是两栋楼。今天所有被动（每个功能纠结放哪、两套消息、Vue2/Vue3 分叉、跨系统移动要重开发）的根源都在这。所以这次做真合并，时机和收敛度都是对的：不加新功能、纯整合，这个口径比我预期的好。"}`, (v) => v.items[0].type === "callout" && v.items[0].tone === "info" && v.items[0].title === "核心判断"],
  ["bare table root, type lost (signature inference)", `{"columns":["a","b"],"rows":[["1","2"]]}`, (v) => v.items[0].type === "table" && v.items[0].rows.length === 1],
  ["shell with title only stays un-wrapped (no false positive)", `{"title":"只有标题"}`, (v) => v.items === undefined && v.title === "只有标题"],
];

let pass = 0;
for (const [name, input, check] of cases) {
  try {
    const v = parseSpec(input);
    // check === "reject" asserts honest degradation (parseSpec must return null)
    const ok = check === "reject" ? v === null : v ? check(v) : false;
    console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
    if (ok) pass++;
    else console.log("   got:", JSON.stringify(v)?.slice(0, 120));
  } catch (e) {
    console.log(`ERROR ${name}: ${e.message}`);
  }
}
console.log(`${pass}/${cases.length} passed`);
process.exit(pass === cases.length ? 0 : 1);
