# dsh-vscode 改造路线图（2026-09-02 竞品分析驱动）

> 前置结论见 competitor-analysis.md。战略前提：**用户将持续升级 DSH 到最新版本**——协议自适应是一切工作的地基。
> 执行纪律：每 Phase 结束跑 pnpm compile / pnpm build / 对应回归；渲染护城河（dshui.tsx / markdown.tsx / 修复管线）在 Phase 0/1 零改动。
>
> **Phase 0 / Phase 1 状态：已落地**（协议双 flavor 自适应；视觉对齐；Phase 2 的部分条目也已顺带完成：队列编辑、图片附件、会话列表状态点、goal 进度卡、代码高亮…）。下方 Phase 0-1 保留为历史记录，不再动工。

## 需求三（当前）— 对照桌面版能力补强（2026-09-30 盘点，**待用户圈选**）

**盘点口径**：桌面版 0.2.0-rc.2（asar 内 `dsh-api-remotes` 网关描述符）共 **136 个端点**，插件源码引用 **20 个**，未引用 **116 个**；桌面版另带 **79 个能力包**（客户端 UI / 功能 bundle）。**未引用 ≠ 缺口**——大量端点是桌面专属界面（插件管理器、设置面板、账户、终端、目录选择器、浏览器侧栏），在 VSCode 场景要么重复、要么不该做。下表只留"用户真会用到"的。
**代价口径**：低 = 半天内；中 = 约 1 天；中高 = 约 2 天（含手测与回归）。

### 第一批（建议先做：价值/代价比最高）

| # | 优化项 | 依赖端点/包（已核对存在） | 价值 | 代价 |
|---|---|---|---|---|
| 1 | **跨会话搜索** | `session/search`（桌面版后端 = `dsh-session-query-sqlite` 的 SQLite FTS5） | 高：本机已有 93 个会话，现在只能肉眼翻 | 中：命令 + 结果列表 + 点击跳转会话 |
| 2 | **会话整理：置顶 / 归档 / 取消归档** | `workspace/pinSession` `unpinSession` `archiveSession` `unarchiveSession` | 高：列表不再混杂，顺带能清"未分组"噪音 | 低：列表项动作（右键/悬停） |
| 3 | **交付物卡片：本次会话改了哪些文件** | `dsh-client-ui-deliverables`（changed-files 卡 + 逐文件对比 + 正文文件引用可点）、`workspaceFiles/changes` | 高：验收场景一眼看全 | 中：卡片 + 复用已有原生 diff |

### 第二批（补现有功能的洞）

| # | 优化项 | 依赖端点/包 | 价值 | 代价 |
|---|---|---|---|---|
| 4 | 子代理抽屉在 0.2.0 上的真修复 + 续跑/中断 | `subagents/prompt` `subagents/interruptByParent`（`subagents/list` 已移除 → 当前降级为空列表） | 中高 | 中 |
| 5 | 计划模式评审链路（计划卡确认/编辑） | 0.2.0 走 `userQuestions/*` + `plan` 投影；`$events/result` 应答通路已实测可用 | 中高 | 低中（需一次真实交互实测） |
| 6 | Goal 控制（暂停/继续/完成/清空） | `goals/create` `edit` `pause` `resume` `complete` `clear` `get` | 中 | 低（当前只有只读 GoalBar） |
| 7 | 后台任务列表 + 中断 | `job/list` `follow` `kill` + `dsh-client-ui-jobs` | 中 | 中 |
| 8 | Agent Teams 编队看板（roster + 任务板） | `agentTeam` 投影 + `dsh-experimental-client-ui-agent-team` | 中高（你在用 Agent Teams） | 中高 |

### 第三批（锦上添花）

| # | 优化项 | 依赖端点/包 | 价值 | 代价 |
|---|---|---|---|---|
| 9 | 定时提醒管理 | `schedule/list` `update` `delete` `history` `catalog` + `dsh-client-ui-schedule` | 中 | 中 |
| 10 | 消息点赞 / 点踩 | `messageFeedback/put` `list` `delete` | 低 | 低 |
| 11 | 余额 / 账户信息 | `account/getBalance` `getProfile` | 低中（花钱可见性好） | 低 |
| 12 | 工作流运行卡片 | `workflow/*` 事件 + `dsh-client-ui-workflow-run` | 中 | 中 |
| 13 | DSH 插件 / bundle 管理 | `pluginManager/*` | 中 | 中高 |
| 14 | 打字机效果（按 `assistant/message` 内 `stream[].dt` 回放） | 0.2.0 消息时间线 | 低 | 低中 |

### 明确不做（连同理由）

- **终端面板**（`terminal/*`）：VSCode 自带终端更强，重复造。
- **文件树 / 文档预览 / 内置浏览器**（`workspaceFiles/list|read`、`sidebar-documentpreview`、`sidebar-browser`）：VSCode 原生更好。
- **目录选择器**（`directoryPicker/*`）：VSCode 原生。
- **DSH 设置面板**（`settings/*`）：本体设置更全，插件做一半反而让用户分不清"该在哪改"。
- **语音输入 / 转写**（`dsh-experimental-voice-input`、`speech-to-text`）：IDE 场景不合适。
- **动态插件运行面板**（`dynamicCordisRunner/*`）：属于 DSH 本体的开发工具。

**顺手核对（非新功能）**：审批/提问应答走 `$events/result` 载体（legacy `/api/respond` 路由已在 0.2.0 消失，只影响 0.1.1-rc.x）→ 实测 HTTP 200 受理回执，**0.2.0 上可用**。

## Phase 0 — 协议自适应层（最先动工）

目标：rc.2（点式端点 + 双 WS + /api/respond）与 0.1.2+（斜杠端点 + 单 WS remote.mux + token 换 cookie）双 flavor 自动探测适配；未知协议形态明确横幅，绝不静哨死循环。

| 文件 | 改动 |
|---|---|
| docs/design.md + AGENTS.md | 先行修订：删「锁 rc.7+」策略，写双 flavor 契约与持续升级常态假设 |
| src/connection/protocol.ts（新） | 协议描述符 + 探测器（先试 session/list 斜杠，回退 session.list/host.describe；缓存+重连重探；未知→横幅） |
| src/connection/client.ts | 端点映射表 dot↔slash（session.history↔session/page、session.models↔session/modelCatalog、goal.*↔goals/*、agentPreset.*↔agentPresets/*、skill.list↔skills/list、workspace.list 移除）；v012 {args} 信封 + cookie 头 |
| src/connection/auth.ts（新） | v012 token→cookie：拉起路径从子进程 stdout 抓授权 URL；外部启动读 dsh 日志（实施时探明路径，最大开放风险）；401 刷新重试一次 |
| src/connection/events.ts + lifecycle.ts | 流抽象：legacy 双 WS vs v012 单 WS remote.mux（session/follow、session/control、workspace/follow、$events；open/cancel/item/end/error、指数退避+代际守卫，移植竞品 MIT 设计） |
| src/session/manager.ts | respond 分支（POST /api/respond vs $events/result waterfall）；history 分页差异（beforeSeq vs address+throughSeq） |
| webview/ | **零改动**（协议知识只进 src/connection 的红利） |
| scripts/smoke.mjs | flavor 分路径：本地 rc.2 实测 legacy；装 0.1.2 后实测 v012；用户每次升 DSH 后跑一遍即知适配状态 |

验收：两个 flavor 各完成 连接/列表/对话/审批/提问/diff 六项闭环 + 断线重连对账；未知形态有横幅。
风险：0.1.2 仍是 alpha 会再变——探测器 + 宽松解析（铁律#2）是长期防线；token 外部启动路径探不明则降级「v012 推荐由插件拉起」。

## Phase 1 — 视觉对齐（与 Phase 0 无耦合）

目标：移植竞品设计系统（MIT），React 架构重实现。交付「UI 变好」的主体感知。

| 文件 | 改动 |
|---|---|
| webview/src/components/icons.tsx（新） | 竞品 ICONS 线条图标表（~30 path，24×24 stroke1.8）+ `<Icon/>`；文件头 MIT 署名 |
| webview/src/styles.css | :root 增 9 个 --dsh-* 令牌 + color-scheme；composer 14px 圆角/focus-within 变 accent/min72-max320/34px 圆发送钮；msg-user 右对齐 max-92%；msg-role 10px 大写角色行；工具卡 10px 圆角内联缩进+状态三色；stats-line 10px 底行；context-bar 4px 三档；fork-divider 999px 胶囊；files-card accent 边；审批红系/提问蓝系 |
| webview/src/app.tsx | 头部两行（会话行+工具行：🌐浏览器+状态点）；回合结束消息操作条（复制/👍👎/feedback/从此处分叉）；会话统计行（投影+derive 兜底）；上下文用量条；回合分隔线；turn-status 活动行（活动+计时） |
| webview/src/fold.ts | 每回合产物推导（view.locations 的 diff/edit 卡，不信任 turn/start deliverables）；轮数/步骤统计 |
| protocol.ts + extension.ts + panel.ts | 新消息：open-file、feedback、fork-at{atSeq}、open-browser |

验收：compile/build 零错误；装 vsix 实测基线三项（连接/发消息/diff）+ 新增手测（操作条三钮、统计行与 GUI 对拍、上下文条三档、产物卡与 GUI 一致、亮暗主题图标、与竞品截图主观对齐）；fence/repair 回归全绿。

## Phase 2 — 功能补强（后续）

代码语法高亮（双方都无，补齐即代差）/ 队列编辑与插队（updateQueue 已通）/ 图片按钮+附件入口 / 会话列表富化（未读点/状态徽标）/ goal 进度卡（goal.* RPC）/ color-scheme 等细节（并入 Phase 1 顺带）/ serializeEventsForWire 式 delta 合并下发。

## Phase 3 — 大件按需（后续）

git-rollback 借用（npm 包直接安装 + 宿侧预览 UI；只装 profiles/web 避免全局污染）/@dsh Chat Participant / commit 生成器 / @ 提及扩展（智能体/会话）。

## 不做

四面板全对等、15 语言 i18n、服务器接管、O(n²) 式重绘、向用户全局 node_modules 写文件。
