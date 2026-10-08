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

- 版本 **0.21.2**（`dsh-web-vscode-0.21.2.vsix`，已装；0.21.0/0.21.1 是之前两版）
- 工作区回归全绿（102/102）；`args:audit` 0 漂移（43 覆盖点）；**截图不入库**（`docs/mockups/shots/` 只留 `.gitkeep`，需要时按 §5 重拍——历史截图会变成误导源）
- 0.21.0 落地后做过一次**独立子代理对抗性复核**（只读、不共享写作上下文）→ 结论 PASS WITH ISSUES → 0.21.1 修了 4 条实质问题 + 降级 2 处过强断言（详见 CHANGELOG v0.21.1）
- **0.21.2 修用户报的"面板没有新建会话入口"**：0.19.5 停用旧工具行时把 `＋` 与工作区管理入口一起丢了 ⇒ 头部补 `＋`（设计稿位置：`⋯` 之后）、会话抽屉说明行右端补「＋ 新建会话」「工作区…」
- **待用户确认**：装 0.21.2 后 Reload Window —— ①头部胶囊是否出现（0.21.1 的开口项）②点 `＋` 是否新建会话、抽屉里「工作区…」是否打开工作区面板

## 3. 已完成

**第一轮（0.19.5–0.20.6）**：单行头部 · 状态胶囊（goal 浮层、无目标零占行）· 工具组折叠 · 抽屉域 tab · 会话域筛选 chip · 二级 tab · 预设下沉 · 会话行 `⋯` 菜单 · 移除 👍👎 与 role 行 · 窄档媒体查询（<520px）· 宽档抽屉停靠（≥620px）· 字阶/行距按本体令牌统一 · 统一分段控件选中态

**第二轮（0.21.0，接本文件 §6 三件全做完）**：
- **P0 状态胶囊看不到** → 判定**布局无问题**（220/260/300/340/680px 逐档截图 + 量 `scrollWidth`/胶囊 rect 全绿，0.20.6 的"标题可收缩"已生效；复核另给结构论据：胶囊 `flex:none` 且排在 `spacer`/`⋯` 之前 ⇒ 挤压顺序是"标题→spacer→⋯"）。两条候选原因分别加固：①**主题**（原依赖 `--vscode-badge-*`，用户主题下曾"蓝字叠蓝底"）⇒ 字色改 `--vscode-foreground`、底色/描边由前景色 color-mix 派生；②**bundle 版本**（同版本覆盖安装时 URI 不变 + 资源缓存）⇒ URI 带 `?v=<版本号>`
- **P2 抽屉截图钩子** → `app.tsx` 支持 `?drawer=sessions|jobs|settings|…`（白名单；并在挂载时补一次 `get-settings`/`get-prefs`，让截图路径与真实点击拉同一批数据）；harness 删掉"代点按钮"与"每次截图强制开搜索抽屉"的杂散代码
- **P1 设置瘦身** → 第一屏四条人话设置（默认模型 / 本会话权限 / 连哪个实例 / 找不到时自动打开桌面版）+ 两个出口 + schema 表单收进「高级」默认收起；协议新增 `prefs` / `get-prefs` / `set-pref` / `select-instance`（仅扩展↔webview）

**第三轮（0.21.1，复核修正）**：`defaultModel` 作用域改 **Workspace**（原来写 Global 会被工作区值盖住 ⇒ 假控件；空串＝取消钉选写 `undefined`）· 模型目录里 provider/model 含 `/` 的项不进下拉 + 写入前 `parsePinnedModel` round-trip 校验 · `permission` 帧带 `sessionId`、webview 侧按来源会话作废（修串台）· `set-pref` 白名单 + 失败 notify · 版本横幅分两层（宿主 `host html v…` / bundle `webview bundle v…`，构建期注入）· `.header { overflow:hidden }` 兜底

## 4. 未完成 / 开口项

| 优先级 | 事项 | 现状 |
|---|---|---|
| **P0** | 状态胶囊**用户侧**确认 | 布局与主题两条已实测排除/加固；等用户 Reload 后确认。若仍不出现，先要：①头部截图 ②`DSH: Show Logs` 里 `[dsh-vscode] webview bundle v…` 那行（bundle 身份，宿主那行不作数） |
| P1 | 宽档停靠时画布被压 | 编辑区标签页 ≥620px 时 wide 抽屉占 620px ⇒ 画布只剩 ~280px；未动 |
| P2 | 窄档下限 | **实测**：面板 <200px 时 `.app` 的 min-content ≈194px（由 messages/composer 的不可断内容决定），头部右端会被推出可视区（140px 截图可见胶囊被裁）；VS Code 侧栏最小宽度大于该值、更窄时面板本身不可用 ⇒ 未做专项断点，头部加了 `overflow:hidden` 兜底 |
| P3 | 模型 id 含 `/` 的模型 | 钉选默认模型只能选 provider/model 均不含 `/` 的项（设置值格式限制），这类模型在设置页选不了（会误解析）；根治需把 pin 改成两字段 |
| P4 | 设置页"默认模型"下拉 | 依赖模型目录已到（`get-models`）；目录为空时降级成只读 + 「去 VSCode 设置改」 |

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

**截图自检**（`docs/mockups/harness.html`）：用桩 `__dshApi` 喂真实形状消息，在浏览器里跑真实 `dist/webview.js`。出图写在 `docs/mockups/shots/`（**该目录已 gitignore，不会有截图混进提交**；目录本身用 `.gitkeep` 保留）。
```powershell
$exe="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"   # 必须独立 profile，否则截图会静默失败留旧图
& $exe --headless=new --no-first-run --disable-gpu --hide-scrollbars `
  --user-data-dir="$env:TEMP\edge-$(Get-Random)" --window-size=900,860 --virtual-time-budget=9000 `
  --screenshot="D:\03-Projects\Plugins\dsh-vscode\docs\mockups\shots\x.png" `
  "file:///D:/03-Projects/Plugins/dsh-vscode/docs/mockups/harness.html?w=340&long=1&cb=$(Get-Random)"
```
- **面板宽由 `?w=` 决定，不要靠 `--window-size` 调窄**（headless 下 window-size ≠ 布局 viewport，会得到假的"溢出"截图）。窗口给大（900+），面板给 220–680。
- 查询参数：`w`（面板宽）· `drawer=sessions|jobs|settings|…`（直接开抽屉）· `long=1`（超长标题）· `goal=0`（不发 goal 投影 ⇒ 胶囊"设目标"态）
- 诊断（`--dump-dom` 里读 `#log`）：`layout:`（viewport / root.clientW / app.scrollW / headerRow.scrollW / capsule.right）、`minContent:`（强行压到 120px，看谁不肯收缩 + 各子块宽度）、`capsule style:`（实际生效色）

**判据（0.21.1 实测钉死，别再凭感觉争论布局）**
- 胶囊是否在可视区：`capsule.right ≤ root.clientW`。**实测**面板 220px 起一切正常；<200px 时 `.app` 的 min-content ≈194px（messages/composer 的不可断内容）会把头部右端推出可视区，140px 截图可见胶囊被裁。
- "我看的是哪一版"：只认日志里 `[dsh-vscode] webview bundle v…`（构建期注入的 bundle 身份）；`host html v…` 是宿主版本，旧 bundle 也会打印新值。

**坑清单（都踩过）**
1. **同版本号覆盖安装不会被 VS Code 重新加载** ⇒ 每次安装必须**升版本号**（跨版本安装会换版本目录，但同版本覆盖时资源 URI 不变 + 存在缓存层，故 webview URI 另带 `?v=` 兜底）
2. esbuild 不校验类型 ⇒ 打包前必须 `pnpm compile` 0 错
3. **JSX 里的 `/* … */` 是文本节点**，会显示在界面里（Markdown 的 `**粗体**` 同理，会原样显示 → 文案里别写 Markdown）
4. 历史遗留规则在 `styles.css` 前部（如 `.session-list{max-height:240px}`），覆盖关系看文件末尾追加区
5. harness 内联脚本语法错误 ⇒ 整页白屏；看 `JS 已执行` 标记 + 顶部错误横幅
6. 浏览器里看不到 console ⇒ 页面内置诊断行 + `--dump-dom` 读 `#log`
7. `pnpm package` 在本机 shell 里会因 `pnpm` 不在 PATH 而失败 ⇒ 直接 `node esbuild.mjs` + `node node_modules\@vscode\vsce\vsce package --no-dependencies`（注意是 `vsce` 这个 shim，不是 `out/main.js`——后者只是导出函数，跑它等于啥也没干、还 exit 0）

8. **停用旧 UI 块（`{false && …}`）会把入口一起带走**（2026-10-08 用户报「面板上没有新建会话入口」）：0.19.5 把头部收成单行时，`＋`（新建会话）与工作区管理都留在了被停用的旧工具行里 ⇒ 三周无人可达。**判据**：停用前先列一遍"用户能点到的入口清单"，逐个确认已搬进新位置（这条也已写进 `AGENTS.md` 验证纪律）。

## 6. 接手先做什么

1. 先问用户 0.21.2 的确认结论：①头部胶囊是否出现 ②`＋` 新建会话、抽屉「工作区…」是否可用。
2. 若用户报新问题：**先按 §5 截图复现**（能复现再动手，别凭推测改 CSS），改动后跑 §5 的判据。
3. §4 里 P1（宽档停靠画布 280px）/ P3（含 `/` 的模型 id 钉选）按用户反馈优先级做。
4. 每次改动：`compile` → `build` → `regress:all` → 截图自检 → 升版本号打包 → CHANGELOG 追加；**非平凡改动建议起一个独立子代理复核**（本轮就是这么抓出 4 条实质问题的）。

## 7. 相关文件

- `webview/src/app.tsx`（面板全部 JSX；`Sheet` 组件最底部；`SHEET_TABS` 在 `Sheet` 定义前，负责把域 tab 渲染到抽屉内部——**必须渲染在抽屉内，否则被遮罩盖住**；`initialDrawer()` 是 `?drawer=` 钩子）
- `webview/src/styles.css`（**末尾追加区**是按轮次叠加的修正）
- `src/ui/panel.ts`（webview HTML 与资源 URI；`?v=` 版本串在这里）
- `docs/design.md`（唯一权威：§3.8 = 设置域两类设置的边界 + webview 资源版本）
- `docs/ui-refactor-proposal.md`（结构方案）· `docs/mockups/ui-v2.html`（高保真设计图）· `docs/mockups/harness.html`（截图自检）
- `CHANGELOG.md`（每个版本的改动与验证）