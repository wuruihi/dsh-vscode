# DSH 插件面板 · UI 重构交接文档（2026-09-30 第二轮收尾）

> **用途**：跨会话接手。上一轮（0.19.5–0.20.6）在做面板 UI 重构，本文件记录**当前状态 + 下一步**。
> 仓库：`D:\03-Projects\Plugins\dsh-vscode`（VS Code 插件；规则 `AGENTS.md`；协议权威 `docs/design.md`）

---

## 1. 目标与已确认的设计

面板 = **会话画布 + 输入区**。管理面收进**一个抽屉**，抽屉只有**一个导航轴**：

```
┌ 会话 │ 诊断 │ 设置 ……………………………… 关闭 ┐   ← 第一层：仅三域 + 关闭（不得再放动作按钮）
├──────────────────────────────────────────┤
│ 会话域：搜索框(独占一行) → 全部/运行中/归档 → 列表(撑满) → 共 N 个会话·仅当前工作区 │
│ 诊断域：二级 tab [任务] [子代理] [轨迹]（顶层仍高亮"诊断"）                        │
│ 设置域：四条人话设置 + 两个出口 + 「高级（服务器设置）」默认收起（见 §3）           │
└──────────────────────────────────────────┘
```
- 头部只有一行：`● 会话标题 ⌄ ✎` + **状态胶囊** + `⋯`（打开抽屉）+ `＋`
- **提醒 / 产出**只放在**状态胶囊浮层**里（不在抽屉里）
- 输出区：正文 14/22、段距 10；同轮连续工具合并为折叠单行；无 👍👎；无 role 行；模型与预设已下沉到输入区

## 2. 当前版本与状态

- 版本 **0.21.0**（`dsh-web-vscode-0.21.0.vsix`）
- 工作区**未 push**；回归全绿；`args:audit` 0 漂移（43 覆盖点）；截图矩阵 7 张（`docs/mockups/shots/v210-*`）
- **待用户确认（唯一开口）**：装 0.21.0 后 Reload Window，头部状态胶囊是否出现

## 3. 已完成

**第一轮（0.19.5–0.20.6）**：单行头部 · 状态胶囊（goal 浮层、无目标零占行）· 工具组折叠 · 抽屉域 tab · 会话域筛选 chip · 二级 tab · 预设下沉 · 会话行 `⋯` 菜单 · 移除 👍👎 与 role 行 · 窄档媒体查询（<520px）· 宽档抽屉停靠（≥620px）· 字阶/行距按本体令牌统一 · 统一分段控件选中态

**第二轮（0.21.0，接本文件 §6 三件全做完）**：
- **P0 状态胶囊看不到** → 判定**不是布局问题**（220/260/300/340/680px 逐档截图 + 量 `scrollWidth`/胶囊 rect 全绿，0.20.6 的"标题可收缩"已生效）；真因是 **`dist/webview.js` 的 URI 跨重装不变 + VS Code 资源缓存** ⇒ 用户看的是旧 bundle。修：webview URI 带 `?v=<版本号>` + 首行打印 bundle 版本；顺带把胶囊做成**主题无关**（字色 `--vscode-foreground`、底色/描边由前景色 color-mix 派生）
- **P2 抽屉截图钩子** → `app.tsx` 支持 `?drawer=sessions|jobs|settings|…`（白名单）；harness 删掉"代点按钮"与"每次截图强制开搜索抽屉"的杂散代码
- **P1 设置瘦身** → 第一屏四条人话设置（默认模型 / 本会话权限 / 连哪个实例 / 找不到时自动打开桌面版）+ 两个出口 + schema 表单收进「高级」默认收起；协议新增 `prefs` / `get-prefs` / `set-pref` / `select-instance`（仅扩展↔webview）

## 4. 未完成 / 开口项

| 优先级 | 事项 | 现状 |
|---|---|---|
| **P0** | 状态胶囊**用户侧**确认 | 机制已修（见 §3），等用户 Reload 后确认；若仍不出现，先要头部截图 + `DSH: Show Logs` 里的 `[dsh-vscode] webview bundle v…` 行 |
| P1 | 宽档停靠时画布被压 | 编辑区标签页 ≥620px 时 wide 抽屉占 620px ⇒ 画布只剩 ~280px；未动 |
| P2 | 窄档外观核对 | 220/340px 截图已看，未与用户逐项确认 |
| P3 | 设置页"默认模型"下拉 | 依赖模型目录已到（`get-models`）；目录为空时降级成只读 + 「去 VSCode 设置改」 |

## 5. 验证与工具（含踩过的坑）

**命令**（node 路径 `C:\Users\wurui\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`，pnpm 用其 `pnpm\bin\pnpm.mjs`）
```
pnpm compile   # 硬门槛：esbuild 不校验类型，类型错照样能打包安装
pnpm build
node --check dist/extension.cjs          # 宿主 bundle 语法自检（compile 不覆盖模板串里的 JS）
node scripts/fold-regress.cjs / fence / pathlink / locate / model / repair
pnpm args:audit（Electron-as-node + DSH_ROOT=资源目录\app.asar\dsh）
scripts/smoke.mjs --base-url http://127.0.0.1:19387 --from-credentials
```

**截图自检**（`docs/mockups/harness.html`）：用桩 `__dshApi` 喂真实形状消息，在浏览器里跑真实 `dist/webview.js`。
```powershell
$exe="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"   # 必须独立 profile，否则截图会静默失败留旧图
& $exe --headless=new --no-first-run --disable-gpu --hide-scrollbars `
  --user-data-dir="$env:TEMP\edge-$(Get-Random)" --window-size=900,860 --virtual-time-budget=9000 `
  --screenshot="D:\03-Projects\Plugins\dsh-vscode\docs\mockups\shots\x.png" `
  "file:///D:/03-Projects/Plugins/dsh-vscode/docs/mockups/harness.html?w=340&long=1&cb=$(Get-Random)"
```
- **面板宽由 `?w=` 决定，不要靠 `--window-size` 调窄**（headless 下 window-size ≠ 布局 viewport，会得到假的"溢出"截图）。窗口给大（900+），面板给 220–680。
- 查询参数：`w`（面板宽）· `drawer=sessions|jobs|settings|…`（直接开抽屉）· `long=1`（超长标题）· `goal=0`（不发 goal 投影 ⇒ 胶囊"设目标"态）
- 诊断（`--dump-dom` 里读 `#log`）：`layout:`（viewport / root.clientW / app.scrollW / headerRow.scrollW / capsule.right）、`minContent:`（强行压到 120px，看谁不肯收缩）、`capsule style:`（实际生效色）

**坑清单（都踩过）**
1. **同版本号覆盖安装不会被 VS Code 重新加载** ⇒ 每次安装必须**升版本号**；现在 webview 资源额外带 `?v=` 版本串（§3 P0）
2. esbuild 不校验类型 ⇒ 打包前必须 `pnpm compile` 0 错
3. **JSX 里的 `/* … */` 是文本节点**，会显示在界面里
4. 历史遗留规则在 `styles.css` 前部（如 `.session-list{max-height:240px}`），覆盖关系看文件末尾追加区
5. harness 内联脚本语法错误 ⇒ 整页白屏；看 `JS 已执行` 标记 + 顶部错误横幅
6. 浏览器里看不到 console ⇒ 页面内置诊断行 + `--dump-dom` 读 `#log`

## 6. 接手先做什么

1. 先问用户 0.21.0 的**胶囊确认结论**（含截图 / bundle 版本号）；这是唯一可能还没闭环的点。
2. 若用户报新问题：**先按 §5 截图复现**（能复现再动手，别凭推测改 CSS）。
3. P1 宽档停靠（画布 280px）与 P2 窄档核对，按用户反馈优先级做。
4. 每次改动：`compile` → `build` → `regress:all` → 截图自检 → 升版本号打包 → CHANGELOG 追加。

## 7. 相关文件

- `webview/src/app.tsx`（面板全部 JSX；`Sheet` 组件最底部；`SHEET_TABS` 在 `Sheet` 定义前，负责把域 tab 渲染到抽屉内部——**必须渲染在抽屉内，否则被遮罩盖住**；`initialDrawer()` 是 `?drawer=` 钩子）
- `webview/src/styles.css`（**末尾追加区**是按轮次叠加的修正）
- `src/ui/panel.ts`（webview HTML 与资源 URI；`?v=` 版本串在这里）
- `docs/design.md`（唯一权威：§3.8 = 设置域两类设置的边界 + webview 资源版本）
- `docs/ui-refactor-proposal.md`（结构方案）· `docs/mockups/ui-v2.html`（高保真设计图）· `docs/mockups/harness.html`（截图自检）
- `CHANGELOG.md`（每个版本的改动与验证）