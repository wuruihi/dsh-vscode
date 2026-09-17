/**
 * restore-links.cjs — 离线重建 pnpm junction 链接（换机拷贝后自愈）。
 *
 * 背景：pnpm isolated linker 用 junction 把 node_modules/<name> 指向
 * .pnpm/<pkgid>/node_modules/<name>。把整个仓库拷贝到另一台机器
 * （或用不保留 junction 的方式复制）后，这些链接会退化成**空目录**，
 * 表现为：目录看着都在，但 tsc/esbuild 报 Cannot find type definition /
 * Cannot find module。pnpm 存储（store）通常也不会被拷过来。
 *
 * 本脚本不联网、不装 pnpm、不删源码：只把「空目录」换成指向 .pnpm
 * 真实路径的 junction。映射全部取自 pnpm 自己写的元数据（即 ground
 * truth，不猜版本），共三路来源：
 *   1. .package-map.json 的 packages[].dependencies  → 各包自己的 node_modules
 *   2. @vscode/vsce 的 @secretlint/* → 根 node_modules（vsce 从 cwd 解析规则名）
 *   3. .modules.yaml 的 hoistedDependencies          → .pnpm/node_modules 私有 hoist 层
 * 非空目录一律不碰；随时可用 pnpm install 还原。
 *
 * 用法：
 *   node scripts/restore-links.cjs           干跑，只报告
 *   node scripts/restore-links.cjs --apply   实际创建链接
 */
const fs = require("fs");
const path = require("path");

const NM = path.join(__dirname, "..", "node_modules");
const MAP = path.join(NM, ".package-map.json");
const APPLY = process.argv.includes("--apply");

if (!fs.existsSync(MAP)) {
  console.error("找不到 " + MAP + "，无法重建（需先 pnpm install 一次）。");
  process.exit(1);
}
const pkgMap = JSON.parse(fs.readFileSync(MAP, "utf8")).packages;

function targetOf(pkgId) {
  const rec = pkgMap[pkgId];
  if (!rec || !rec.url) return null;
  return path.resolve(NM, rec.url);
}

function isEmptyDir(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isDirectory()) return false;
    return fs.readdirSync(p).length === 0;
  } catch {
    return false;
  }
}

/**
 * 容器目录 = 该包自己的 node_modules。
 * 注意作用域包：`.pnpm/@vscode+vsce@x/node_modules/@vscode/vsce` 的容器是
 * 上两级的 `.../node_modules`，不是 `.../node_modules/@vscode`（作用域目录
 * 只用来放该 scope 自己的包，把依赖塞进去会让 node 解析不到）。
 */
function containerNMOf(pkgId) {
  if (pkgId === ".") return NM;
  const target = targetOf(pkgId);
  if (!target) return null;
  const parent = path.dirname(target); // .../node_modules 或 .../node_modules/@scope
  return path.basename(parent).startsWith("@") ? path.dirname(parent) : parent;
}

const plan = []; // { link, target }
let skippedOk = 0, skippedMissingTarget = 0;

for (const [pkgId, rec] of Object.entries(pkgMap)) {
  if (!rec || !rec.dependencies) continue;
  const containerNM = containerNMOf(pkgId);
  if (!containerNM) { skippedMissingTarget += Object.keys(rec.dependencies).length; continue; }
  for (const [alias, depId] of Object.entries(rec.dependencies)) {
    const target = targetOf(depId);
    if (!target || !fs.existsSync(target)) { skippedMissingTarget++; continue; }
    const link = path.join(containerNM, alias);
    if (fs.existsSync(link) && !isEmptyDir(link)) { skippedOk++; continue; }
    plan.push({ link, target });
  }
}

const uniq = new Map();
for (const p of plan) if (!uniq.has(p.link)) uniq.set(p.link, p);

/**
 * 补充 hoist：`@vscode/vsce` 在 pnpm 严格布局下打包会失败——它的
 * secretlint 校验会从 **cwd（仓库根）** 解析规则包名，而 `@secretlint/*`
 * 只是 vsce 的传递依赖，根 node_modules 里没有，于是报
 * `Failed to load secretlint's rule module`。
 * 官方解法是在 .npmrc/pnpm-workspace.yaml 配 `public-hoist-pattern`；
 * 这里不改项目配置，只把 vsce 依赖里的 @secretlint/* 链到根目录，
 * 效果等同（纯本地链接，可逆）。
 */
const vsceId = Object.keys(pkgMap).find((k) => k.startsWith("@vscode/vsce@"));
if (vsceId) {
  for (const [alias, depId] of Object.entries(pkgMap[vsceId].dependencies || {})) {
    if (!alias.startsWith("@secretlint/")) continue;
    const target = targetOf(depId);
    if (!target || !fs.existsSync(target)) continue;
    const link = path.join(NM, alias);
    if (fs.existsSync(link) && !isEmptyDir(link)) { skippedOk++; continue; }
    plan.push({ link, target });
  }
}

/**
 * 第三路来源：`.pnpm/node_modules` 私有 hoist 层。
 * pnpm 会把包按别名 hoist 到 `.pnpm/node_modules/<alias>`，供 `.pnpm` 内
 * 深层解析兜底（hoistPattern ["*"]、publicHoistPattern [] → 全部为 private，
 * 即只放这一层、不上根目录）。映射表是 pnpm 写在 `node_modules/.modules.yaml`
 * 的 `hoistedDependencies`（pkgId → {alias: "private"}），**是 ground truth**，
 * 因此多候选包（chalk、semver…存在多个版本）也不需要猜哪个版本。
 * 这一层同样是拷贝时被压平的受害者。
 */
let hoistPlanned = 0, hoistMissing = 0;
try {
  const modulesMeta = JSON.parse(fs.readFileSync(path.join(NM, ".modules.yaml"), "utf8"));
  const hoistNM = path.join(NM, ".pnpm", "node_modules");
  for (const [pkgId, aliases] of Object.entries(modulesMeta.hoistedDependencies || {})) {
    for (const alias of Object.keys(aliases || {})) {
      let target = targetOf(pkgId);
      if (!target || !fs.existsSync(target)) {
        // 回退：按 pnpm 的目录命名规则推导（'/' → '+', '(x)' → '_x'）
        const mangled = pkgId.replace(/\//g, "+").replace(/\(/g, "_").replace(/\)/g, "");
        const guess = path.join(NM, ".pnpm", mangled, "node_modules", alias);
        if (fs.existsSync(guess)) target = guess;
        else { hoistMissing++; continue; }
      }
      const link = path.join(hoistNM, alias);
      if (fs.existsSync(link) && !isEmptyDir(link)) { skippedOk++; continue; }
      hoistPlanned++;
      plan.push({ link, target });
    }
  }
} catch (e) {
  console.log("（未读到 .modules.yaml，跳过 hoist 层重建：" + e.message + "）");
}

const todo = [...new Map(plan.map((p) => [p.link, p])).values()];

/**
 * 清理「错放在作用域目录里的非作用域包链接」——修复本脚本早期版本
 * 把作用域包的依赖 link 建到 `node_modules/@scope/<plainName>` 的缺陷。
 * 判据：作用域目录下的 symlink，其目标父目录不是另一个作用域目录。
 * 只删 symlink（且解析到本地 .pnpm），绝不删真实目录。
 */
function misplacedLinks() {
  const found = [];
  const vstore = path.join(NM, ".pnpm");
  let pkgs; try { pkgs = fs.readdirSync(vstore); } catch { return found; }
  for (const p of pkgs) {
    const scopeDir = path.join(vstore, p, "node_modules");
    let scopes; try { scopes = fs.readdirSync(scopeDir, { withFileTypes: true }); } catch { continue; }
    for (const sc of scopes) {
      if (!sc.isDirectory() || !sc.name.startsWith("@")) continue;
      const d = path.join(scopeDir, sc.name);
      let kids; try { kids = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      for (const k of kids) {
        const lp = path.join(d, k.name);
        let st; try { st = fs.lstatSync(lp); } catch { continue; }
        if (!st.isSymbolicLink()) continue;
        let rt; try { rt = fs.realpathSync(lp); } catch { continue; }
        // 目标是 `<...>/node_modules/<plainName>` → 说明被错放进作用域目录
        if (!path.basename(path.dirname(rt)).startsWith("@")) found.push(lp);
      }
    }
  }
  return found;
}

const misplaced = misplacedLinks();
if (misplaced.length) console.log("发现错放的链接（需清理）: " + misplaced.length);

console.log("依赖图包数        : " + Object.keys(pkgMap).length);
console.log("需重建的链接      : " + todo.length + "（其中 .pnpm 私有 hoist 层 " + hoistPlanned + "）");
console.log("已完好（跳过）    : " + skippedOk);
console.log("目标缺失（跳过）  : " + (skippedMissingTarget + hoistMissing));
console.log("\n样例（前 10）:");
for (const t of todo.slice(0, 10)) {
  console.log("  " + path.relative(NM, t.link).replace(/\\/g, "/") + "  ->  " + path.relative(NM, t.target).replace(/\\/g, "/"));
}

if (!APPLY) {
  console.log("\n[干跑] 未做任何改动。加 --apply 执行。");
  process.exit(0);
}

let made = 0, failed = 0, cleaned = 0;
for (const lp of misplaced) {
  try { fs.unlinkSync(lp); cleaned++; } catch {}
}
for (const t of todo) {
  try {
    fs.mkdirSync(path.dirname(t.link), { recursive: true });
    if (fs.existsSync(t.link) && isEmptyDir(t.link)) fs.rmdirSync(t.link);
    if (fs.existsSync(t.link)) { skippedOk++; continue; }
    fs.symlinkSync(t.target, t.link, "junction");
    made++;
  } catch (e) {
    failed++;
    if (failed <= 8) console.log("  失败 " + path.relative(NM, t.link) + ": " + e.message);
  }
}
console.log("\n已清理错放: " + cleaned + "   已创建: " + made + "   失败: " + failed);

// 复检：顶层 + .pnpm 私有 hoist 层。
// 注意 .d.ts 不是 JSON，不能用 JSON.parse —— 按「可读且非空」判定即可。
const check = ["typescript/package.json", "@types/node/index.d.ts", "esbuild/package.json", "@vscode/vsce/package.json", "react/package.json", "ws/package.json", "highlight.js/package.json", "react-markdown/package.json"];
console.log("\n复检关键包:");
for (const f of check) {
  try {
    const st = fs.statSync(path.join(NM, f));
    if (st.size === 0) throw new Error("empty");
    console.log("  [OK] " + f + "  (" + st.size + "B)");
  } catch (e) { console.log("  [FAIL:" + (e.code || e.message) + "] " + f); }
}

// 剩余空目录（坏链残留）——正常应只剩 .pnpm/node_modules/.bin 这类真实空目录
let leftover = [];
(function scan(dir, depth) {
  if (depth > 6) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    let inner = []; try { inner = fs.readdirSync(p); } catch {}
    if (inner.length === 0) leftover.push(path.relative(NM, p));
    else scan(p, depth + 1);
  }
})(NM, 0);
console.log("\n剩余空目录（坏链残留）: " + leftover.length);
leftover.slice(0, 15).forEach((d) => console.log("  " + d.replace(/\\/g, "/")));
