# dsh-web-vscode 项目记忆

## 项目身份（重要）

- **GitHub 仓库**：https://github.com/wuruihi/dsh-vscode （仓库名 `dsh-vscode`）
- **市场扩展 ID**：`wurui.dsh-web-vscode`（display: DeepSeek Harness (DSH)）
- **为什么名字不一致**：Marketplace 的扩展名跨发布者全局唯一，`dsh-vscode` 已被他人占用（且不可见/已下架），改名 `dsh-web-vscode`。查询验证方法：`extensionquery` API，filterType 7 = 精确 ID，filterType 10 = 模糊名。
- **发布者**：`wurui`（用户 GitHub: wuruihi，ID 176995251）
- 命令 ID / 配置键前缀仍是 `dsh-vscode.*`（内部标识，勿改，改了破坏用户键位/设置）

## IDE 能力桥（v0.4.0，V2 第一项）

- 架构：模型工具（ide_active_file / ide_selection / ide_diagnostics / ide_open_file）
  → DSH 插件 `~/.dsh/plugins/dsh-ide-bridge`（defineTool + ctx.tools.register，参照 better-sidebar 备份插件）
  → HTTP 127.0.0.1:3187 + Bearer token（发现文件 `~/.dsh/dsh-vscode-ide.json`，扩展启动写、退出删）
  → dsh-vscode 扩展 `src/ide/bridge.ts`（vscode.languages.getDiagnostics / activeTextEditor / showTextDocument）
- 插件依赖解析：宿主别名 + 兜底 junction（插件目录 node_modules → ~/.dsh/profiles/node_modules）
- 插件改动需重启 dsh web；扩展改动需 Reload Window；两者可独立降级（桥不可达时工具报友好错误）
- defineTool 契约：{name, description, parameters:{p:{type,required,description}}, output:{schema}, async execute(args, exec){exec.signal.throwIfAborted()}}

## V2 完成状态（0.4.5 收口）

- 排版（0.3.x）：14px 中文下限 + 结构化写作，已闭环
- live 状态条移到输入框上方（0.4.2）
- IDE 能力桥（0.4.0/0.4.1）：见上节；0.4.1 修诊断过滤的 Windows 路径失配（必须 `Uri.file()` 规范化后 `toString()` 比对）
- @ 文件引用（0.4.3/0.4.4）：`@` 触发补全（防抖 120ms + reqId 对账）→ 📎 chip → 协议 `{type:"file"}` 占位 → 宿主 `expandFileParts` 展开（2 万字符截断）。气泡只显示一句话 + chips：fold 层识别 `[引用文件 X]` 块抽标签丢正文，对历史消息同样生效
- dsh-ui 渲染器补齐（0.4.5）：mermaid（自研 SVG 子集渲染器：graph TD/LR、三种节点形、实线/虚线/带标签边，最长路分层布局，解析失败降级代码块）+ plot（白名单表达式编译 + 采样折线）。quiz/scene3d 有意不做（频率低/依赖重）
- 遗留：市场最新仍是 0.3.6，0.4.x 系列 vsix 未上传市场（用户手动网页上传，时机由用户定）

## 发布流程

- 本地构建：`corepack pnpm compile`（门控）→ `build` → `vsce package --no-dependencies`
- 发布方式：**市场网页手动上传 vsix**（marketplace.visualstudio.com/manage → + New extension）。
  未走 PAT/vsce login 路线：用户登不上 dev.azure.com；网页上传不需要 PAT。
- 发布后索引传播：查询 API 分钟级可见，详情页/CLI 安装要几分钟~几小时
- git tag：`v0.3.4` 已打

## 网络环境（本机）

- GitHub / Marketplace 直连被重置，走本地代理 `127.0.0.1:7890`（Clash）
- git 已在仓库级配置 http.proxy/https.proxy；curl 用 `-x http://127.0.0.1:7890`
- `code --install-extension <ID>` 走 CLI 直连市场会失败，用本地 vsix 装或等索引后 GUI 装

## 技术要点沉淀

- `session.list` 不带标题 → 标题用 globalState 持久缓存 + 8 并发后台补全（v0.3.4 启动优化）
- dsh-ui 围栏渲染：3 级 JSON 修复（strict → cheap 笔误 → items-merge 结构修复），对齐本体容错
- markdown：remark-breaks 保真单换行（中文分段命门）+ 中文 14px 字号下限 + 行高 1.7
- 助手消息无气泡框（Claude Code 布局公式，从其 webview CSS 逆向）
- 消息流上滑自动加载：scrollTop<=40 触发 + 高度锚定防视口跳动 + 4s 看门狗

## 环境事实

- 仓库路径：`D:\repos\dsh-vscode`；构建产物 vsix 只保留最新一个
- git 身份：wuruihi / 176995251+wuruihi@users.noreply.github.com（noreply 防邮箱泄露）
- 旧原型 `weinibuliu.dsh-vsc` 已卸载退役

## 双协议自适应层（v0.6.0 Phase 0，2026-09-02）

- **触发**：DSH 0.1.2 线协议断代；用户明确「会持续升级 DSH 到最新版本」→ 锁版本策略作废，双 flavor 探测切换（docs/design.md §3.0 是契约唯一权威）
- **架构不变式保住了**：协议知识仍全部收在 src/connection/；V012Streams 在连接层把 v012 帧合成 legacy 形状 payload，manager 与 webview 零改动兼容两种服务器
- **实测线协议坑（alpha.4 实机，竞品源码没写、照抄会翻车）**：args 逐参数精确匹配——单 request 方法包 {request:{…}}、session/list 要 {_request:{}}、gent→wire 名 gentId、commands/execute 的 images 必填、流开帧同样包装（follow → {request:{address}}）；token 只打 stdout（外部启动场景日志扫描无效，dsh-vscode.authToken 设置兜底）
- **验证环境**：alpha 实测用 DSH_HOME=%TEMP%\dsh-alpha-test\home 隔离（不碰 ~/.dsh；无凭据时 finish-error chunk 也证明流式链路）；DSH_HOME 是 dsh 的 home 覆盖开关
- 双 smoke（legacy 11/11 @rc.2:3080、v012 12/12 @alpha.4:3081）+ fence 8/8 + repair 14/14；vsix dsh-web-vscode-0.6.0.vsix
- 下一步 Phase 1（视觉对齐）：见 docs/roadmap.md，渲染护城河文件（dshui/markdown/修复管线）零改动红线

## Phase 1 视觉对齐（v0.7.0，2026-09-02）

- **移植设计系统不抄像素**：令牌（9 个 --dsh-*）、组件规格、ICONS 表（30 path）全部来自竞品 MIT 资产，React/备忘架构不变——护城河文件（dshui/markdown/修复管线）零改动，fence 8/8 + repair 14/14 守绿
- **视觉要点**：composer 14px 圆角卡片 + focus-within accent + 34px 圆发送钮；msg-role 角色行；工具卡三态色；回合 999px 药丸（点击=fork-at 定点分叉，atSeq=turn/end 的 seq）；产物卡（成功 mutation 的 view.locations：card=diff 或 generic+kind=edit，读/删/失败不计）；底部统计行 + 上下文条三档（#4ec9b0/#dcdcaa/#f48771，阈值 60%/85%）
- **新消息四条**：open-file（宿主把相对路径解析到 workspace 根再开）/ open-browser / fork-at / feedback（日志留痕；messageFeedback RPC 是 Phase 2 候选）
- contextPressure 从 tokens 字符串拆成独立 ctxPct 状态喂进度条；会话切换时重置

## Phase 2 首批（v0.8.0，2026-09-02）

- **语法高亮**：highlight.js core + 20 语言子集 + 别名表；接入点=markdown.tsx 的 pre/code 两处微创（code 组件带 data-lang/data-text，pre 读子元素 props 升级为 CodeBlock；无语言围栏/内联码走原路径不变）；调色板映射 VSCode Dark+（body.vscode-light 切亮色）；护城河（分割器/修复管线）零改动，fence/repair 回归守绿
- **装机纪律（教训）**：打包≠安装——v0.7.0 曾因未装机被用户报「UI 没变」；此后每版本打包后立即 code --install-extension 并提醒 Reload Window
- 未读点=非当前会话 running→idle 翻转检测（会话列表 running 标志即可，无需新协议消息）；图片按钮复用粘贴路径

## Phase 2 次批+收官（v0.9.0，2026-09-02）

- **goal 投影是协议无关的**：key=""goal"" 走 session/projection，manager 全键转发早已生效，只差 webview 消费端+history 种子（pv.goal）。形状={goal:{id,revision,objective,phase,maxGoalRounds,blockedReason?},roundsStarted}；phase 四值与 blocked 显示 blockedReason.message 从 dsh-client-ui-goal/lib/client.js 证实
- **updateQueue 动作全集 = edit|remove|steer**（alpha.4 typert.host.js schema 逐字提取）；rc.2 支持面用零污染探测法验证：伪 sessionId 发三动作，全到 queue-item-not-found（schema 全过）而非 arguments-invalid——先验参数后查会话的网关顺序可当免费能力探测器
- **能力探测方法论**：找到包后先 Get-ChildItem -Recurse -Directory -Filter 定位，schema 在 typert.host.js 的 <method>_parameter_0$schema 变量；ReadAllText 全树扫描会超时，Select-String -List 先定位文件

## 面板工具面补齐（v0.10.0，2026-09-02）

- **用户面板对比驱动的一轮**：头部五钮（工作区/任务/轨迹/子代理/设置）+ ＋ 添加菜单 + / 命令按钮 + 统计中文化。git-rollback 用户拍板「值得做但先不做」
- **jobs 白捡**：后台任务= session/jobs 事件帧（竞品状态注释泄底），mux 全帧本就收到，manager 补一条转发即成——零新增 RPC 双 flavor 通用
- **rc.2 能力探测三连**：subagent.list 要 {parentSessionId}（sessionId/agentId 都不行，schema 错误信息直说）；settings.describe {} 直接可用；session.search 在该部署被禁（索引 openAt=never）→ 搜索降级客户端过滤。归档标记 rc.2 session.list 不下发 → 归档区不可建
- **folder 引用展开**：expandFileParts 加 isDirectory 分支 → readdir 浅层清单（[引用目录 … 共 N 项]，cap 200 项）
- **drawer 统一开合**：showSessionList 并入 drawer 状态机（sessions/workspace/jobs/traj/subs），标题按钮= sessions 抽屉，五钮各自互斥开合，is-on 高亮

## v0.11.0：fold 根因修复 + alpha.5 体检（2026-09-02）

- **alpha.5 兼容结论**：deepseek-harness 检出隔离实例 smoke 12/12 全过，Phase 0 双协议层扛住了 alpha.4→alpha.5。破坏面=鉴权：token 每次启动随机打印不落盘（源码无 cookie/persist 痕迹，错误页自述 reopen the URL printed by dsh web）→ authToken 设置成唯一通道，服务器重启要重填。「一键拉起 dsh web + stdout 捕获 token」是彻底解法（竞品 serverStartedByUs 模式），Phase 3 候选
- **转圈根因（教训级）**：rc.2 真实历史证实 tool/result 的 callId 埋在 data.message.source.callId / message.content[0].toolCallId，文本在 content[0].content[0].text——此前 fold 只读顶层字段，静默失配。防御=以真实历史跑 fold 的回归脚本（fold-regress.cjs 9/9），fixture 用实测形状不用想象形状
- **交错渲染架构**：TurnItem.segments（text/thinking/tool 到达序）为渲染唯一事实源，平面字段保留同步（复制/统计兼容）；step/start|end 是 persistent 事件（不是 chunk），原先整体被丢
- 真实历史还有 13k+ 事件的会话（assistant/chunk 占 98%）——RENDER_WINDOW 截断渲染是性能关键，别动

## v0.12.0：免 token 直连（2026-09-02）

- **alpha.5 鉴权彻底解法**：dsh-client-connection 把 32 字节签名 secret 持久化在 ~/.dsh/.credentials.yaml（records.client-connection/browser-session.payload.secret，base64url）且跨重启复用。cookie=「dsh-auth-+b64url(sha256(authority))」=「v1.b64url(json).b64url(hmac-sha256(secret,body))」，payload={version:1,authority,issuedAt,expiresAt}≤30天。本地可铸→插件零配置直连、重启免疫。教训：**「不落盘」的结论要验证到校验方源码为止**——token 不落盘，但校验 cookie 的 secret 落盘且复用
- 发现路径方法论：先定位 401 文案出处（grep 精确报错串）→ 读校验函数（isAuthenticated）→ 顺藤摸 secret 来源（credentials.modifyRecord）
- auth-regress.cjs 是真实服务器集成回归（3080 只读 session/list），SKIP 语义=无服务器/无记录时不算失败

## v0.13.0：chunkrow 历史形状 + 右侧 Sheet（2026-09-02）

- **历史 vs 实时是两套文本载体**：session/page 持久层把 text/reasoning 增量压缩成 chunkrow/text-chunks|reasoning-chunks（data.texts[]），assistant/chunk 在历史里只剩 block/tool-call/usage/finish 帧。fold 这类双通道渲染器必须两套都接——「实时能看、重载丢正文」= 只接了实时通道的典型症状。fold-live.cjs（真实会话回放）应作为每次动 fold 的验证步骤
- **竞品面板交互实证**：panels.ts makePanel + chat.css——fixed 遮罩 justify-flex-end + 右侧 sheet（min(400px,96vw)/宽 620px），0.16s 滑入，Esc+点遮罩关闭，head 放标题+控件+关闭钮。七个面板：工作区(搜索+分组管理)/任务/轨迹(wide+筛选+回合分隔)/设置(wide+schema表单+模型目录+发现模型+预设)/子代理(对话+追问+打断)/Cordis
- v0.13.0 落地：五面板 Sheet 化+任务时长+轨迹时钟/回合分隔+子代理只读对话（subagent-history 协议）。剩余差距：设置表单/全文搜索(部署禁用)/子代理追问打断/工作区分组管理
