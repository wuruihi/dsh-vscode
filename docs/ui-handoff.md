# DSH 插件面板 · UI 重构交接文档（2026-09-30 收尾）

> **用途**：本会话上下文已接近上限，为避免"每次只改一点"的低效节奏，把状态完整交接给新会话。
> **接手第一句建议**：「读 `docs/ui-handoff.md`，按 §6 的三个待办继续，改完先自己截图核对再给我。」
> 仓库：`D:\03-Projects\Plugins\dsh-vscode`（VS Code 插件；规则 `AGENTS.md`；协议权威 `docs/design.md`）

---

## 1. 目标与已确认的设计

面板 = **会话画布 + 输入区**。管理面收进**一个抽屉**，抽屉只有**一个导航轴**：

```
┌ 会话 │ 诊断 │ 设置 ……………………………… 关闭 ┐   ← 第一层：仅三域 + 关闭（不得再放动作按钮）
├──────────────────────────────────────────┤
│ 会话域：搜索框(独占一行) → 全部/运行中/归档 → 列表(撑满) → 共 N 个会话·仅当前工作区 │
│ 诊断域：二级 tab [任务] [子代理] [轨迹]（顶层仍高亮"诊断"）                        │
│ 设置域：4 条人话设置（待做，见 §6-2）                                              │
└──────────────────────────────────────────┘
```
- 头部只有一行：`● 会话标题 ⌄ ✎` + **状态胶囊** + `⋯`（打开抽屉）+ `＋`
- **提醒 / 产出**只放在**状态胶囊浮层**里（不在抽屉里）
- 输出区：正文 14/22、段距 10；**同轮连续工具合并为折叠单行**；无 👍👎；无"你/DSH" role 行；模型与预设已下沉到输入区

## 2. 当前版本与状态

- 版本 **0.20.6**（已打包安装；`dsh-web-vscode-0.20.6.vsix`）
- 工作区干净、**未 push**；回归全绿；`args:audit` 0 漂移（43 覆盖点）
- 用户已确认通过：会话列表撑满 ✓、二级 tab 选中态 ✓、跨工作区搜索按钮已移除 ✓

## 3. 已完成（UI 线）

单行头部 · 状态胶囊（含 goal 操作浮层、无目标零占行）· 工具组折叠 · 抽屉域 tab · 会话域筛选 chip · 二级 tab（诊断域）· 预设下沉 · 会话行 `⋯` 菜单 · 移除 👍👎 与 role 行 · 窄档媒体查询（<520px）· 宽档抽屉停靠（≥620px）· 字阶/行距按本体令牌统一 · 统一分段控件选中态（灰字→加粗+底线）

## 4. 未完成 / 开口项

| 优先级 | 事项 | 现状 |
|---|---|---|
| **P0** | **顶部状态胶囊用户看不到** | 已做"标题可收缩、胶囊不收缩"仍未出现；推测被挤出可视区或未渲染，需先拿到头部截图 |
| P1 | 设置瘦身 | 未动代码（方案见 §6-2） |
| P2 | 抽屉截图钩子 | harness 只能拍主面板；`?drawer=` 测试钩子那次替换匹配到两处未生效 |
| P3 | 宽档停靠 / 窄档外观核对 | 未视觉验证 |

## 5. 验证与工具（含踩过的坑）

**命令**（node 路径 `C:\Users\wurui\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，pnpm 用其 `pnpm\bin\pnpm.mjs`）
```
pnpm compile   # 硬门槛：esbuild 不校验类型，类型错照样能打包安装
pnpm build
node scripts/fold-regress.cjs / fence / pathlink / locate / model / repair
pnpm args:audit（Electron-as-node + DSH_ROOT=资源目录\app.asar\dsh）
scripts/smoke.mjs --base-url http://127.0.0.1:19387 --from-credentials
```

**截图自检**（`docs/mockups/harness.html`）：用桩 `__dshApi` 喂真实形状消息，在浏览器里跑真实 `dist/webview.js`。
```powershell
$exe="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"   # 必须独立 profile，否则截图会静默失败留旧图
& $exe --headless=new --no-first-run --disable-gpu --hide-scrollbars `
  --user-data-dir="$env:TEMP\edge-$(Get-Random)" --window-size=760,900 --virtual-time-budget=9000 `
  --screenshot="docs\mockups\shots\x.png" "file:///D:/03-Projects/Plugins/dsh-vscode/docs/mockups/harness.html?w=680&cb=$(Get-Random)"
```
**坑清单（都踩过）**
1. **同版本号覆盖安装不会被 VS Code 重新加载** ⇒ 每次安装必须**升版本号**（0.19.5 原地覆盖导致用户两轮看到旧界面）
2. esbuild 不校验类型 ⇒ 打包前必须 `pnpm compile` 0 错
3. **JSX 里的 `/* … */` 是文本节点**，会显示在界面里（曾把一句中文注释渲染进助手回复）
4. `.session-list{max-height:240px}`（styles.css:74 历史遗留）导致列表"只占半屏但能滚动"
5. harness 内联脚本语法错误 ⇒ 整页白屏；用 `new Function` / `node --check` 定位（曾因一段 Markdown 示例字符串失败）
6. 浏览器里看不到 console ⇒ 页面内置"JS 是否执行"标记 + 顶层错误横幅

## 6. 接手后按序做这三件

**① 修 P0（胶囊不可见）**：先用 §5 的截图命令拍**头部**（主面板图即可，胶囊在头部一行），看它是否渲染、是否被挤出。候选原因：头部行 `overflow:hidden` + 标题/按钮总宽超限；或胶囊 `max-width:62%` 被压；或胶囊只有"设目标"时样式过淡认不出。改完**先截图自检**再交给用户。

**② 加 `?drawer=` 测试钩子（P2）**：`app.tsx` 里 drawer 的 `useState` 初值改为
`useState<…>((new URLSearchParams(location.search).get("drawer") as …) || "")`
（上次失败原因：`>("")` 匹配到两处 ⇒ 要带上类型参数那一整行做唯一锚点）。生效后即可拍抽屉，用于核对列表/二级 tab/设置页。

**③ 设置瘦身（P1）**：现在设置页把服务端 `settings/describe` 的 schema **原样渲染**，字段是内部名、大多只读 ⇒ 用户"看不懂、啥都不能改"。改为：
- 4 条人话设置：**默认模型**（`dsh-vscode.defaultModel`）· **权限预设** · **连哪个 DSH 实例**（复用 `DSC: Select DSH Instance` 能力）· **找不到时自动打开桌面版**（`dsh-vscode.autoStart`）
- 底部一个「打开 DSH 本体的设置」出口（点开本体 GUI）
- 现有 schema 表收进「高级（服务器设置）」折叠、**默认收起**
- 若某项确实无法在插件侧写入，就**不要显示假的控件**：显示当前值 + 「去 VSCode 设置改」按钮

## 7. 相关文件

- `webview/src/app.tsx`（面板全部 JSX；`Sheet` 组件在最底部；`SHEET_TABS` 在 `Sheet` 定义前，负责把域 tab 渲染到抽屉内部——**必须渲染在抽屉内，否则被遮罩盖住**）
- `webview/src/styles.css`（**末尾追加区**是按轮次叠加的修正，历史遗留规则在文件前部，注意覆盖关系）
- `docs/ui-refactor-proposal.md`（结构方案）· `docs/mockups/ui-v2.html`（高保真设计图）· `docs/mockups/harness.html`（截图自检）
- `docs/plan-req3-batch1/2/3.md`（需求三三批的方案与审查记录）· `CHANGELOG.md`（每个版本的改动与验证）