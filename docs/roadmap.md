# dsh-vscode 改造路线图（2026-09-02 竞品分析驱动）

> 前置结论见 competitor-analysis.md。战略前提：**用户将持续升级 DSH 到最新版本**——协议自适应是一切工作的地基。
> 执行纪律：每 Phase 结束跑 pnpm compile / pnpm build / 对应回归；渲染护城河（dshui.tsx / markdown.tsx / 修复管线）在 Phase 0/1 零改动。

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
