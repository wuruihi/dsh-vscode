/**
 * args-audit.mjs — typert 网关参数契约审计（离线、确定性）。
 *
 * 为什么需要它：v012 的 args 必须与网关描述符「逐参数精确匹配」
 * （dsh-api-gateway assertExactArguments），多键/缺键/改名都会被拒。
 * 这套契约**随 DSH 版本漂移**，且漂移时表现是运行期才报
 * `gateway/arguments-invalid`——smoke.mjs 只覆盖连接层主干，盖不到
 * commands/execute、subagents/list 这类业务端点，于是漏网。
 * 实测教训（0.1.2-alpha.4 → 0.1.5-rc.2）：
 *   commands/execute  images → submittedAttachments
 *   subagents/list    {request:{...}} → 平铺 {parentSessionId}
 *
 * 做法：从**已安装的 DSH**解析网关描述符（ground truth），
 * 与本插件 src/connection/client.ts 里 v012Request 调用点、remote.ts 里的
 * 流开帧（openStream）、以及 client.ts 的 {request} 包裹集合比对实际发送的
 * 顶层参数名。不连服务器、不需要 token，升级后立刻可跑。
 *
 * 覆盖边界（2026-09-30 补）：原先只扫 client.ts 的静态 v012Request 调用点，
 * remote.ts 的 4 个流开帧与 wrapped 集合不在覆盖内（0.2.0 恰好新增
 * session/projections 类端点），漏审会在升级后以运行期
 * `gateway/arguments-invalid` 暴露。现在两者都进审计。
 *
 * 用法：node scripts/args-audit.mjs
 *      DSH_ROOT=<dsh 运行目录> node scripts/args-audit.mjs
 *      # 审桌面版（asar 内）必须用 Electron 当 node，否则 existsSync 在 asar
 *      # 上恒为 false —— 那会「静默 SKIP 当 PASS」，所以这里改成硬失败：
 *      $env:ELECTRON_RUN_AS_NODE=1
 *      & "<install>\DeepSeek Harness.exe" --expose-internals scripts/args-audit.mjs
 *      #   DSH_ROOT=<install>\resources\app.asar\dsh
 * 退出码：0 = 全部匹配；1 = 存在漂移；2 = 定位不到 DSH（含 asar 未用 Electron 读）
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const CLIENT_TS = join(REPO, "src", "connection", "client.ts");
const REMOTE_TS = join(REPO, "src", "connection", "remote.ts");
const allowMissing = process.argv.includes("--allow-missing");

// ---------- 定位已安装的 DSH ----------
function locateDshRoot() {
  const cands = [
    process.env.DSH_ROOT,
    join(process.env.USERPROFILE ?? "", "dsh"),
    join(process.env.HOME ?? "", "dsh"),
  ].filter(Boolean);
  for (const c of cands) {
    const gw = join(c, "node_modules", "@deepseek-ai", "dsh-api-remotes", "lib", "client.js");
    if (existsSync(gw)) return { root: c, gateway: gw };
  }
  return null;
}

// ---------- 从网关源码提取描述符（endpoint → args wire 名数组）----------
function parseDescriptors(gatewaySrc) {
  const desc = new Map();
  const idRe = /id:\s*"([^"]+)"/g;
  const marks = [];
  let m;
  while ((m = idRe.exec(gatewaySrc))) marks.push({ id: m[1], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const seg = gatewaySrc.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : gatewaySrc.length);
    const ps = seg.indexOf("parameters:");
    let names = [];
    if (ps >= 0) {
      let pe = seg.indexOf("cancellation:", ps);
      if (pe < 0) pe = seg.indexOf("result:", ps);
      if (pe < 0) pe = seg.length;
      names = [...seg.slice(ps, pe).matchAll(/name:\s*"([^"]+)",\s*wire:\s*"([^"]+)"/g)].map((x) => x[2]);
    }
    const ep = marks[i].id.split("#").pop();
    if (ep && !desc.has(ep)) desc.set(ep, names);
  }
  return desc;
}

// ---------- 提取插件实际发送的顶层参数名 ----------
/** 小括号/大括号配对，取 `{` 位置对应的顶层键名 */
function topLevelKeys(src, braceStart) {
  let depth = 0;
  const parts = [];
  let cur = "";
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      if (depth === 0) break;
    }
    if (ch === "," && depth === 1) {
      parts.push(cur);
      cur = "";
      continue;
    }
    if (depth >= 1) cur += ch;
    if (depth === 1 && i === braceStart) cur = ""; // 丢掉开头的 '{'
  }
  if (cur.trim()) parts.push(cur);
  const keys = [];
  for (const p of parts) {
    const k = p.split(":")[0].trim().replace(/^\.\.\./, "").trim();
    if (k && /^[A-Za-z_$][\w$]*$/.test(k)) keys.push(k);
  }
  return keys;
}

function parseCallSites(src) {
  const sites = [];
  const re = /v012Request(?:<[^>]*>)?\(\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(src))) {
    const ep = m[1];
    const after = src.indexOf(",", m.index + m[0].length);
    const brace = src.indexOf("{", after);
    // 跳过非字面量（动态构造的 args 无花括号字面量）
    if (brace < 0 || brace - after > 30) {
      sites.push({ endpoint: ep, keys: null });
      continue;
    }
    const keys = topLevelKeys(src, brace);
    const line = src.slice(0, m.index).split("\n").length;
    sites.push({ endpoint: ep, keys, line });
  }
  return sites;
}

// ---------- 主流程 ----------
const located = locateDshRoot();
if (!located) {
  if (allowMissing) {
    console.log("SKIP  未定位到已安装的 DSH（--allow-missing）");
    process.exit(0);
  }
  const explicit = (process.env.DSH_ROOT ?? "").trim();
  console.error(
    explicit
      ? `FAIL  DSH_ROOT=${explicit} 下找不到 node_modules/@deepseek-ai/dsh-api-remotes/lib/client.js`
      : "FAIL  未定位到已安装的 DSH（设 DSH_ROOT 指向 dsh 运行目录后重试）",
  );
  console.error(
    "      审桌面版（asar 内）必须用 Electron 当 node：普通 node 的 existsSync 在 asar 上恒为 false，\n" +
      "      旧版脚本会「静默 SKIP 并 exit 0」，看起来是绿的、实际没审。正确命令：\n" +
      '        $env:ELECTRON_RUN_AS_NODE=1\n' +
      '        & "<install>\\DeepSeek Harness.exe" --expose-internals scripts/args-audit.mjs\n' +
      '        # DSH_ROOT=<install>\\resources\\app.asar\\dsh   （<install> 例如 %LOCALAPPDATA%\\Programs\\DeepSeek Harness）',
  );
  process.exit(2);
}
if (located.root.toLowerCase().includes("app.asar") && !process.versions.electron) {
  console.error(
    "FAIL  DSH_ROOT 指向 app.asar，但当前不是 Electron 运行时 —— 读不到 asar 内容。\n" +
      '      请用：$env:ELECTRON_RUN_AS_NODE=1; & "<install>\\DeepSeek Harness.exe" --expose-internals scripts/args-audit.mjs',
  );
  process.exit(2);
}
console.log(`DSH 运行目录: ${located.root}`);

const desc = parseDescriptors(readFileSync(located.gateway, "utf8"));
console.log(`网关描述符: ${desc.size} 个方法\n`);

const src = readFileSync(CLIENT_TS, "utf8");
const sites = parseCallSites(src);
console.log(`插件 v012Request 调用点: ${sites.length} 个\n`);

let bad = 0;
const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** 已知且**已在代码里显式降级**的漂移：网关没有该端点，但插件能安全退化，
 *  所以不算审计失败（会打印 HANDLED，保持可见）。新增条目必须同时指出
 *  运行期的降级位置——否则就是拿白名单掩盖漂移。 */
const HANDLED_DRIFT = new Map([
  [
    "subagents/list",
    "DSH 0.2.0 已移除（只剩 subagents/prompt + subagents/interruptByParent）；" +
      "client.ts 的 subagent.list 分支首次失败即告警并停止调用，子智能体树改由 session/list 的 origin/parentSessionId 派生",
  ],
]);

for (const s of sites) {
  // `$`-前缀是网关内置端点（$events / $events/result），不经 typert 描述符
  // 校验——由 dsh-api-gateway 自己的 parseRemoteEventResult 单独校验。
  if (s.endpoint.startsWith("$")) {
    console.log(`SKIP   ${s.endpoint}（client.ts:${s.line}）— 网关内置端点，非 typert 方法`);
    continue;
  }
  if (!desc.has(s.endpoint)) {
    if (HANDLED_DRIFT.has(s.endpoint)) {
      console.log(`HANDLED ${s.endpoint}（client.ts:${s.line}）— ${HANDLED_DRIFT.get(s.endpoint)}`);
      continue;
    }
    console.log(`FAIL   ${s.endpoint}（client.ts:${s.line}）— 网关无此方法（已改名或移除）`);
    bad++;
    continue;
  }
  const expect = desc.get(s.endpoint);
  if (s.keys === null) {
    console.log(`SKIP   ${s.endpoint}（client.ts:${s.line}）— args 动态构造，静态不可判定`);
    continue;
  }
  if (eq(s.keys, expect)) {
    console.log(`PASS   ${s.endpoint}  [${s.keys.join(", ")}]`);
  } else {
    console.log(`FAIL   ${s.endpoint}（client.ts:${s.line}）`);
    console.log(`         插件发送: [${s.keys.join(", ")}]`);
    console.log(`         网关要求: [${expect.join(", ")}]`);
    bad++;
  }
}

// ---------- 覆盖度自查：插件能发出的其它端点是否都存在 ----------
const mapRe = /"([a-zA-Z][\w.]*)":\s*"([^"]+)"/g;
const mapped = new Set();
const endpointOf = new Map();
let mm;
while ((mm = mapRe.exec(src))) {
  if (!mm[2].includes("/")) continue;
  mapped.add(mm[2]);
  endpointOf.set(mm[1], mm[2]);
}
const missingEp = [...mapped].filter((e) => !desc.has(e));
if (missingEp.length) {
  console.log(`\nWARN   METHOD_MAP 中 ${missingEp.length} 个端点不在网关描述符里: ${missingEp.join(", ")}`);
}

// ---------- 流开帧（remote.ts openStream）：原先不在审计覆盖内 ----------
const frameSites = [];
if (existsSync(REMOTE_TS)) {
  const remoteSrc = readFileSync(REMOTE_TS, "utf8");
  const re = /openStream\(\s*"([^"]+)"\s*,\s*\{/g;
  let fm;
  while ((fm = re.exec(remoteSrc))) {
    const brace = remoteSrc.indexOf("{", fm.index + fm[0].length - 1);
    frameSites.push({
      endpoint: fm[1],
      keys: topLevelKeys(remoteSrc, brace),
      line: remoteSrc.slice(0, fm.index).split("\n").length,
    });
  }
}
console.log(`\n流开帧（remote.ts openStream）: ${frameSites.length} 个`);
for (const s of frameSites) {
  if (s.endpoint.startsWith("$")) {
    console.log(`SKIP   ${s.endpoint}（remote.ts:${s.line}）— 网关内置端点，非 typert 方法`);
    continue;
  }
  if (!desc.has(s.endpoint)) {
    console.log(`FAIL   ${s.endpoint}（remote.ts:${s.line}）— 网关无此端点（已改名或移除）`);
    bad++;
    continue;
  }
  const expect = desc.get(s.endpoint);
  if (eq(s.keys, expect)) {
    console.log(`PASS   ${s.endpoint}  [${s.keys.join(", ")}]`);
  } else {
    console.log(`FAIL   ${s.endpoint}（remote.ts:${s.line}）`);
    console.log(`         插件发送: [${s.keys.join(", ")}]`);
    console.log(`         网关要求: [${expect.join(", ")}]`);
    bad++;
  }
}

// ---------- {request} 包裹集合（client.ts wrapped）：原先不在审计覆盖内 ----------
const wrappedMatch = /const wrapped = new Set\(\[([\s\S]*?)\]\)/.exec(src);
if (wrappedMatch) {
  const methods = [...wrappedMatch[1].matchAll(/"([^"]+)"/g)].map((wm) => wm[1]);
  console.log(`\n{request} 包裹方法（client.ts wrapped）: ${methods.length} 个`);
  for (const method of methods) {
    const endpoint = endpointOf.get(method) ?? method.replace(/\./g, "/");
    if (!desc.has(endpoint)) {
      console.log(`FAIL   ${endpoint}（${method}）— 网关无此方法（已改名或移除）`);
      bad++;
      continue;
    }
    const expect = desc.get(endpoint);
    if (eq(["request"], expect)) {
      console.log(`PASS   ${endpoint}  [request]`);
    } else {
      console.log(`FAIL   ${endpoint}（${method}）— 插件按 request 包裹发送`);
      console.log(`         网关要求: [${expect.join(", ")}]`);
      bad++;
    }
  }
}

console.log(`\n${bad === 0 ? "PASS" : "FAIL"}  args 审计：${bad} 处不匹配`);
process.exit(bad === 0 ? 0 : 1);
