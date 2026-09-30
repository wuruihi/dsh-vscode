# dsh-vscode 设计文档（spec）

> 2026-08-17 立项。调研输入：dsh-vsc 0.1.13（反面教材）、Claude Code VSCode 2.1.235（交互蓝图）、用户自研 Obsidian 插件 deepseek-harness-native 0.1.3（协议考古）、DSH 0.1.0-rc.7 本体源码。

## 1. 目标与非目标

**目标**：在 VSCode 里获得与 DSH GUI 同等的 agent 协作体验，并把 VSCode 的编辑器上下文（选区/活动文件）真实喂给 agent，把 agent 的动作（diff/审批）翻译成 VSCode 原生交互。

**非目标**：
- 不做 agent 运行时（DSH 本体就是）
- 不自管 dsh web 实例、不做 broker（dsh-vsc 脆根因）。**2026-09-30 修订**：连接对象改为「运行中的实例」——默认附身桌面版 App（端口是宿主写死的 19387），其次旧 CLI（3080）。插件自己起服务降级为「两处都不通时的最后手段」，且只允许旧 CLI 拉起且必须显式警告（§3.5）
- V1 不做 IDE 能力反连桥（getDiagnostics 等是 V2）
- **不追 DSH alpha 的每日变动，但必须同时兼容「当前 stable（0.1.1-rc.x）」与「下一代（0.1.2+ 线协议）」两个 flavor，连接时探测自动切换**（2026-09-02 修订：原「锁定 rc.7+」策略作废——用户将持续升级 DSH 到最新版，协议断代即全插件失效；见 §3.0）

## 2. 架构

```
┌─ VSCode ──────────────────────────────┐
│ Webview (React)                        │
│  ├ fold 状态机：事件流→视图模型        │
│  └ 虚拟化消息列表 + markdown 渲染      │
│    ↕ postMessage（增量，16ms 微批）     │
│ 扩展宿主 (Node)                         │
│  ├ connection/：RPC 客户端 + 双 WS 下行 │
│  ├ session/：workspace 匹配、会话管理   │
│  ├ context/：选区/活动文件→content 块   │
│  └ diff/：dshdiff: 虚拟 scheme provider │
└────────────┬───────────────────────────┘
             │ http://127.0.0.1:{19387|3080}/api/*
             │ ws://127.0.0.1:{19387|3080}/api/remote.mux
┌────────────┴───────────────────────────┐
│ 运行中的实例：桌面版 App(19387) / 旧 CLI │
│ （与 GUI 共享会话、插件、持久化）        │
└────────────────────────────────────────┘
```

**关键架构决策**：

| 决策 | 理由 |
|---|---|
| fold 放 webview 侧，扩展宿主只转发原始事件 | postMessage 天然增量，规避 dsh-vsc 全量快照 O(n²) |
| 扩展宿主连协议，webview 不直连 | DSH 信任栅栏拒 webview Origin（Obsidian 版实测 403/1006） |
| 不依赖 DSH 内部包 | dsh-vsc require 内部 zod schema，DSH 升级即碎 |
| 附身运行中的实例：**默认 19387 桌面版 App**，其次 3080 旧 CLI（2026-09-30） | 会话/插件与 GUI 共享；桌面版是 0.2.0 且 nightly 自动更新，与「常开桌面版」的实际用法一致；不再固定 3080 |
| 协议双 flavor + 探测切换（2026-09-02） | 用户持续升级 DSH；协议知识集中在 src/connection，webview 对协议变更免疫 |

## 3. 协议契约（实测，来自 Obsidian 版考古 + rc.7 源码核对）

### 3.0 协议 flavor（2026-09-02 引入）

DSH 0.1.2 起线协议破坏性变更。插件同时支持两个 flavor，连接时探测自动切换：

| 维度 | legacy（0.1.1-rc.x，本节 3.1-3.4 均为此 flavor） | v012（0.1.2-alpha.4+） |
|---|---|---|
| HTTP 端点 | 点式 `/api/session.list`，payload 直传 | 斜杠 `/api/session/list`，payload 包 `{args}` 信封；`host.describe` 移除（探测改 `session/list`） |
| 认证 | 无 | `GET /?token=<启动token>` 换签名 cookie，所有请求携带；401 刷新重试。token 来自 dsh web 启动输出/日志的授权 URL |
| 事件通道 | 双 WS `events.mux` + `events.host`，只下行 | 单 WS `/api/remote.mux` 多路逻辑流：`session/follow`、`session/control`、`workspace/follow`、`$events`；帧 `{type:"open"/"cancel",streamId,endpoint,payload}`，服务端回 item/end/error |
| 审批/提问应答 | `POST /api/respond`（裸回执 receipt） | `$events/result` waterfall outcome |
| 端点改名 | `session.history` | `session/page`（address + throughSeq 分页） |
|  | `session.models` | `session/modelCatalog` |
|  | `goal.*` / `agentPreset.*` / `skill.list` | `goals/*` / `agentPresets/*` / `skills/list` |
|  | `workspace.list` | 移除（列表由 `workspace/follow` 流提供） |
| session.prompt | — | 需客户端预生成 requestId |

探测顺序：先试 `session/list`（v012），404/失败回退 `session.list`/`host.describe`（legacy）；结果缓存，重连失败即重探；两试皆败 → 状态横幅「协议不识别」。v012 契约细节以竞品 apiClient.ts（MIT，0.12.90 源码）+ 本地 0.1.2 服务器实测为准，`src/connection/protocol.ts` 为唯一 flavor 判定点。

**v012 实测线协议事实（2026-09-02 首测于 0.1.2-alpha.4；2026-09-17 复测于 0.1.5-rc.2）**：
- 一元 RPC 的 `args` 必须与描述符**逐参数精确匹配**（`dsh-api-gateway` assertExactArguments）：每个业务参数一个键，键名 = 参数名或 lookup wire 名。多键/缺键都报 `gateway/arguments-invalid`。
- **参数名与包裹方式随版本漂移**：0.1.5-rc.2 实测 `commands/execute` 必填字段由 `images` 改名为 `submittedAttachments`；`subagents/list` 由 request 包裹改回平铺。任何一次 DSH 升级都要重跑参数审计，不要假设契约稳定。
- 单 `request` 参数的方法 → `args:{request:{...}}`：session/create、prompt、cancel、rename、fork、attachment、updateQueue、selectModel、page、workspace/create、archiveSession、unarchiveSession、pinSession、unpinSession、skills/list。
- 特例：`session/list` → `args:{_request:{}}`（保留参数名 `_request`）；`modelCatalog`/`agentPresets/list` → `args:{}`。
- `agent: Agent` 参数走 lookup，wire 名 `agentId`：agentPresets/select、commands/list、commands/execute。**commands/execute 的 `submittedAttachments` 是网关必填字段**（无附件也传 `[]`）。
- `subagents/list` 在 0.1.5-rc.2 改为**平铺** `args:{parentSessionId}`（0.1.2-alpha.x 曾是 `args:{request:{parentSessionId}}`）——同一方法跨 RC 版本包裹方式会变，升级后必须重跑 args 审计。
- **升级后必跑**：`pnpm args:audit`（`scripts/args-audit.mjs`）——**纯离线、确定性**：从**已安装的 DSH** 解析网关描述符当 ground truth，与源码里每个 `v012Request` 调用点逐端点比对顶层参数名，漂移即非零退出。**不连服务器、不需 token**（连服务器的 A/B 探针只在首次定契约时用过），`DSH_ROOT` 可覆盖解析目录。
- 流开帧同样走参数匹配：`session/follow` → `payload:{args:{request:{address,maxMessages?}}}`；`session/control`、`workspace/follow`、`$events` → `args:{}`。
- `$events/result` 精确三键 `{clientId, eventId, outcome}`；outcome `{kind:"result",value?}|{kind:"rejected",error}|{kind:"next"}`。
- 会话事件信封与 legacy 完全一致（`assistant/chunk` 的 `data.chunk.type` 仍是 `text-delta`/`finish`…），fold 零改动。
- 鉴权：`GET /?token=` 换 set-cookie（首段即 cookie）。**token 只打印在 dsh web 的 stdout**——外部终端启动时无日志文件可扫，auth.ts 的日志扫描只对「插件拉起（stdout 重定向到 ~/.dsh/dsh-vscode-web.log）」可靠；外部启动场景靠 `dsh-vscode.authToken` 设置兜底。
- 竞品 0.12.90 的 apiClient 未实现 `{request:...}` 包装（平铺传参），其一元调用在真实 alpha.4 上同样会被网关拒绝——我们以实测为准，不照抄。

### 3.1 RPC 通道

- `POST http://127.0.0.1:3080/api/<method>`，Content-Type: application/json
- 请求信封：`{"type":"client-request","rpcId":"<uuid>","method":"<m>","payload":{...}}`
- 响应：`{"type":"server-response","rpcId":"...","result":{"ok":true,"value":{...}}}`，失败为 `{"ok":false,"error":{code,message}}`
- 审批/追问应答走 `POST /api/respond`：`{"type":"client-response","rpcId":<原请求rpcId>,"result":{"ok":true,"value":{sessionId,approvalId,outcome:"allowed-once"|"rejected"}}}`；追问 value 为 `{sessionId,answer:{answers:[...]}}`。**注意 outcome 是 `allowed-once` 不是 `allowed`**（rc.7 源码 approvals.schema.js 枚举，发错必被拒）
- respond 的回执是 receipt：`{accepted:true}` 或 `{accepted:false, reason:"not-pending"|"bad-response"}`——**不是** server-response 信封；`not-pending` 表示他端（GUI/另一窗口）已应答，据此收敛本端卡片

### 3.2 事件通道

- `ws://127.0.0.1:3080/api/events.mux`（会话域）+ `ws://.../api/events.host`（宿主域），只下行
- 每帧：`{"type":"server-request","rpcId":"...","method":<payload.type>,"payload":{...}}`。**`method` 字段就是 `payload.type`**（如 `session/event`、`approval/requested`），分发判断统一用 `payload.type`
- **全量广播所有会话，mux 会话域帧必须按 `payload.sessionId` 过滤**；host 域帧与 `stream/error` 无 sessionId，全量处理
- `session/event` 帧可自带宿主预解析的 `view` 字段（工具参数已解好的对象）——工具参数优先取 `view`，没有才自己 JSON.parse（宿主对解析失败有自己的降级，跟它走更稳）
- mux payload 类型：`session/event`（内层 turn/start、assistant/chunk（`text-delta`/`reasoning-delta`/`block-start`/`block-end`/`tool-call`/`tool-result`/`agent-start`/`agent-end`/`subagent-start`/`subagent-end`/`usage`/`finish`/`turn/end`/`user/message`）、`session/projection`（key: title/tokenUsage/contextPressure/permissions）、`approval/requested|resolved`、`question/requested|resolved`、`session/queue`、`session/jobs`
- host payload：`host/session-added|removed`、`host/session-status{running}`、`host/workspace-changed|removed|order-changed` 等
- 扩展宿主是 Node 原生 ws 客户端，无 Origin 坑；断线指数退避重连，重连后 `session.history` 对账 + `session/subscribed.lastSeq` 续传

### 3.3 用到的方法

`host.describe`（探活）、`workspace.list`（**v012 无此端点**：`client.ts` 内部转 `workspacesOnce()` → `workspace/follow` baseline，详见 §3.6）/`workspace.create{path}`/`workspace.pinSession{sessionId}`/`workspace.unpinSession{sessionId}`/`workspace.archiveSession{sessionId}`/`workspace.unarchiveSession{sessionId}`、`session.list`/`session.create{workspaceId|cwd, agentPreset?}`/`session.prompt{sessionId, mode:"queue"|"steer", content:[{type:"text",text}|{type:"image",mediaType,data}], clientTimeZone?}`/`session.cancel{sessionId}`/`session.history{sessionId, maxMessages?, beforeSeq?}`/`session.models`/`session.selectModel{sessionId,provider,model,reasoningEffort?}`/`session.rename`/`session.updateQueue`

### 3.4 已知坑（必须内置对策）

1. 模型选择用 `m.id`，不用 `m.name`（大写 400）
2. workspace 路径归一化（`\`→`/`、大小写）再匹配，防误 create 报 ENOENT
3. 新建会话可能收不到 `session/subscribed`（rc.7 已在 session/created 推，仍保留 history 对账兜底）
4. 空轮（warmup）不算 turn 结束；`turn/end` 才收尾
5. runtime context 可能混在 assistant 输出 → stripSystemContext 清洗（沿用 Obsidian 版正则）
6. `usage`/`finish` chunk 是元数据，不渲染
7. 权限 projection 只推变化，初值用 `settings.describe` 补拉

### 3.5 实例选择（2026-09-30：桌面版共存后引入）

本机同时存在两套 DSH：桌面 Electron App（0.2.0-rc.2）与旧 CLI（0.1.5-rc.1）。两者**共用同一个 `~/.dsh`**（会话/`storages`/凭据都在 `.dsh` 根下，`profiles/<name>/` 只放 cordis 与 node_modules），所以「连接对象」从「固定的 3080」变成「运行中的实例」：

| 实例 | 地址 | profile | 挂载与限制 |
|---|---|---|---|
| 桌面版 App | `http://127.0.0.1:19387` —— **宿主里的字面量**（`dsh-desktop-host/lib/index.js` 传 `args:["--no-open","--port","19387"]`，全 asar 仅此一处，**无端口回退逻辑**：EADDRINUSE 即启动失败而非换端口） | `desktop` | base + web-app + agent-team + auto-review + schedule + memory-loader（功能最全，且 nightly 自动更新） |
| 旧 CLI | `http://127.0.0.1:3080` | `web` | 只挂 base + web-app；**0.1.5 的会话格式 catalog 是 currentVersion 3、无 v4 codec，读不了 2026-09-30 之后桌面版写的 v4 会话**（同日实测：v3 79 个 / v4 9 个） |

规则：

- **候选是常量表，不做进程→端口扫描**：两个已知候选（19387、3080）都不通才算「没有实例」。`src/connection/instances.ts` 是唯一判定点。
- **显式优先**：`dsh-vscode.baseUrl` 被用户设过（非默认值）→ 只用它、不探测（逃生舱）。
- **可见可切换**：状态条恒显当前实例（地址 + profile + 权限预设），命令面板 `DSH: 选择实例` 切换；选择写回 `dsh-vscode.baseUrl`（Global），多窗口靠 `onDidChangeConfiguration` 同步。
- **切实例必须重建对象**：`DshLifecycle` / `RpcClient` / `Auth` 的 baseUrl 都是构造即固定；`Auth` 的 cookie **按 authority 分键**（cookie 名含 authority 哈希，跨地址必然 401）。
- **兜底不默认起服务**：两处都不通时提示「打开桌面版 App」；`autoStart` 仍保留旧 CLI 拉起，但**必须显式警告**：①会与运行中的桌面版对同一个会话库形成第二个写者；②0.1.5 少三组 bundle 且读不了 v4 会话。
- **红线**：不得把「用桌面版 CLI 起 web profile」当常规兜底——它自带 pnpm + 0.2.0 的 installAnchor，会重装 `~/.dsh/profiles/node_modules`（现为 0.1.5 树），**可能永久打破旧 CLI**；`dsh.cmd` 也不能用 `Start-Process -FilePath` 直接拉（CreateProcess 不执行批处理）。

### 3.6 会话列表状态与搜索（2026-09-30，需求三第一批）

**读路径（v012 无 `workspace/list` 端点，@19387 实测 404）**：`client.ts` 的 `workspace.list` 分支内部转 `workspacesOnce()`——一次 `workspace/follow` **baseline** 帧，形状 `{type:"item", value:{type:"baseline", value:{items:[{workspaceId,path,title,sessionIds,createdAt,updatedAt}], archivedSessionIds:[…], pinnedSessionIds:[…]}}}`。**三字段必须一起取**：`archivedSessionIds`/`pinnedSessionIds` 是"归档/置顶"状态的唯一权威来源（此前 `remote.ts:162` 只取 `items`，两个集合被丢弃 ⇒ 插件侧归档状态恒空、归档形同未生效——本批即修此 bug）。

**写路径**：`workspace/pinSession|unpinSession|archiveSession|unarchiveSession` 均为 `{request:{sessionId}}`（archive 另有可选 `stopActivity`）；legacy 仍传 `workspaceId`（v012 分支内丢弃）。回执只带**一半**集合（pin/unpin → `pinnedSessionIds`；archive/unarchive → `archivedSessionIds`），且**归档会连带丢弃该会话的置顶** ⇒ 写成功后一律**重读 baseline**，不做局部推断。错误语义：`*/not-found`＝会话不存在；`gateway/bad-request`＝已归档的会话不能置顶；`workspace/session-active`＝活动会话不能归档。

**搜索**：`session/search` 在本部署被禁用（`openAt:"never"`），开启需改 DSH 配置（红线）⇒ 插件改用**宿主侧按需过滤**：webview 发 `{t:"search-sessions", reqId, query}`，宿主在 `sessionRows` 上按 title/cwd/工作区名过滤（路径统一 `normalizePath()`）后回 `{t:"search-results", reqId, items}`；**不下发全量列表**（AGENTS.md 硬规则 1），webview 只采纳最新 `reqId` 的回复。

**能力协商**：`{t:"caps", flavor:"v012"|"legacy"}` 与既有 `{t:"conn"}` 并列下发（webview 就绪 + 连接态变更各一次）。legacy 无 pin/unpin/unarchive ⇒ 隐藏这三个动作与"显示归档"开关；webview 的 `flavor` 初值 `undefined` 且按 legacy 处理（避免按钮闪现）。

**交付物点击语义（统一口径）**：面板内清单/卡片点击一律 `open-file`；要看变更才用行内按钮发 `open-diff`（需该文件有 live edit 的 `callId`）。宿主侧命令 `dsh-vscode.showSessionChanges`（QuickPick → diff）以 `TurnEdits.sessionId` 限定**本会话**，切会话即 `resetSession()` 清空。

## 4. 功能规格

### V1（本 spec 范围）

**F1 连接与生命周期**
- activate → **解析实例**（§3.5：显式 baseUrl 优先，否则按 19387 → 3080 顺序探测，谁应答连谁）→ 探活失败则显示状态条与「选择实例」入口；两处都不通且 `autoStart` 开 → 提示「打开桌面版 App」（主）/「启动本地 dsh web（旧版，有警告）」（次）→ Start-Process 脱离启动，轮询就绪 120s
- 状态机：connecting / connected / disconnected / starting，状态条常显并带当前实例标识
- 断线指数退避重连（1s 起步，上限 30s），重连后全量对账；切实例 = 重建 lifecycle/manager（状态全清）

**F2 会话管理**
- workspace 按当前工作区路径归一化匹配，无则 create
- 侧栏顶部会话下拉（标题 + 运行状态点）+ 新建按钮；重命名；与 GUI 双向同步（host/session-added）
- 切换会话用 `session.history` 回放最近 24 条

**F3 对话流**
- 流式正文 + 思考折叠（reasoning-delta 单独通道，默认折叠可展开）
- markdown 渲染（react-markdown + DOMPurify），dsh-ui 围栏 V1 降级为代码块
- 工具卡片：工具名 + 参数摘要 + 折叠详情；`tool-call`/`tool-result` 配对
- **当前工具 live 指示**（已确认进 V1）：顶部状态条显示正在执行的工具名 + 参数摘要，`turn/end` 清除；非当前工具默认折叠（FocusView 简版）
- 子代理活动块（subagent-start/end）
- token 用量投影显示

**F4 审批与提问**
- `approval/requested` → webview 内审批卡（允许=allowed-once / 拒绝=rejected），respond 回环
- `question/requested` → 多选题卡片，批量作答 respond
- 任意会话的审批都路由到 UI（按 sessionId 标注来源会话）
- **多端并发收敛**：同一会话可能 GUI 与插件同时弹卡。收到 `approval/resolved`/`question/resolved`（他端已答）立即撤卡；respond 回执 `not-pending` 同样撤卡并提示"已在其他端处理"，不报错
- 重连时服务端会重放 pending 审批/提问（rpcId 稳定），客户端按 rpcId 幂等去重

**F5 上下文附加（真实内容块）**
- 命令 + 快捷键：发送选区到 DSH（选区优先，无选区发活动文件全文，2 万字符截断）
- 输入区"附加活动文件"开关：发送时把文件内容作为第二个 text 块（带路径标注）
- 图片粘贴 → `image` content part（base64，png/jpeg/webp/gif）；发送前预检大小（从 `imageLimits` projection 读上限），超限直接提示用户，不发请求吃 4xx

**F6 原生 diff（已确认进 V1）**
- `TextDocumentContentProvider` 注册 `dshdiff:` scheme，**URI 带 seq 版本号**（`dshdiff:<encoded-path>?v=<turnSeq>`）：同一文件同一 turn 重复打开/重开都取新内容，杜绝 provider 缓存陈旧原文
- str-replace-editor 的 tool-call（old_string/new_string/file_path）→ 工具卡出现"查看 diff"链接；工具参数优先用事件帧自带的 `view` 字段，缺失才自行解析
- 点击 → `vscode.diff` 打开：左侧 = dshdiff 虚拟原文档（改动前），右侧 = 工作区真实文件（改动后实际状态）
- 左侧文档构建：打开 diff 时读取当前文件内容，按该会话本 turn 累积的编辑序列（file_path, old_string, new_string）**逆序反向应用**得到原文；**反向应用 miss（当前文件已不含 new_string）时该条编辑标记"原文不可精确重建"，diff 头部横幅提示**，不静默给出错误原文
- 会话内变更汇总入口（本次 turn 的文件变更列表）

**F7 模型选择**
- `session.models` 拉取（groups 平铺 + reasoningEffort），`session.selectModel` 切换；用 id

**F8 输入与队列**
- queue / steer 模式切换（steer 用于运行中追加引导）
- 运行中输入默认进 queue，队列项可见可删（session/queue 投影 + updateQueue）
- Enter 发送 / Shift+Enter 换行（可配置）

### V2（展望，不在本 spec）
IDE 能力反连桥（DSH 侧 vscode-bridge 插件，agent 可 getDiagnostics/getCurrentSelection/openFile）、@文件补全、会话树视图、fork、导出、dsh-ui 围栏渲染、终端降级模式。

## 5. 技术栈与目录

- TypeScript strict；esbuild 打包（扩展宿主 cjs，webview esm bundle）；React 18；vsce 打 vsix
- pnpm；Node >=18（VSCode 扩展宿主自带）；依赖尽量少：ws、react、react-markdown、dompurify（+ 少量工具库）

```
dsh-vscode/
├── AGENTS.md                # 项目规范（已建）
├── package.json / esbuild.mjs / tsconfig.json
├── src/
│   ├── extension.ts         # 入口：命令注册、状态条
│   ├── connection/
│   │   ├── client.ts        # RPC：信封、rpcId、超时、respond
│   │   ├── events.ts        # 双 WS 下行、重连、微批转发 webview
│   │   └── lifecycle.ts     # 探活/拉起/状态机
│   ├── session/
│   │   ├── workspace.ts     # 归一化匹配/create
│   │   └── manager.ts       # 当前会话、prompt、queue/steer、history 回放
│   ├── context/attach.ts    # 选区/活动文件/图片 → content 块
│   ├── diff/provider.ts     # dshdiff: scheme + 打开 diff + 变更汇总
│   └── ui/panel.ts          # webview view provider、postMessage 路由
├── webview/
│   ├── index.html
│   └── src/
│       ├── main.tsx / app.tsx
│       ├── fold.ts          # 事件→视图模型状态机（含 stripSystemContext）
│       ├── protocol.ts      # postMessage 消息类型（双侧契约）
│       └── components/      # MessageList(虚拟化)/ToolCard/ApprovalCard/...
└── scripts/smoke.mjs        # 协议 smoke：连 3080 走一遍核心方法
```

## 6. 错误处理

- RPC 失败：区分网络错误（触发重连）与业务错误（`error.code` 展示给用户）
- respond 回执失败：`{accepted:false}` 不是异常，按 reason 分支——`not-pending` 撤卡提示他端已处理，`bad-response` 记诊断日志
- WS 断开：状态条变 disconnected，UI 保留已渲染内容，重连成功后 history 对账增量补
- 拉起失败（120s 未就绪）：横幅报错 + 打开日志指引
- webview 崩溃/重载：扩展宿主重发当前会话 history 重建视图

**已知限制**：拉起命令（Start-Process）为 Windows 专有，V1 不做跨平台（当前用户环境即 Windows）；需要时再补 darwin/linux 分支。

## 7. 性能预算

- 每条 delta 处理路径：扩展宿主不过滤不解析（只按 sessionId 路由），webview fold O(1) 追加
- postMessage 微批 16ms 合帧（requestAnimationFrame 对齐）
- 消息列表虚拟化：只渲染可视区 ±10 条
- 单会话 1000 轮消息滚动不卡（验收线）

## 8. 验证

- `pnpm compile` / `pnpm build` 零错误
- `pnpm smoke`：连**当前实例**（默认 19387）依次调 `session/list` → 建会话 → prompt("回复 ok") → 收到 turn/end → cancel 清理，全绿。桌面版不落 token，必须走 `--base-url http://127.0.0.1:19387 --from-credentials`（从 `~/.dsh/.credentials.yaml` 铸 cookie）
- `pnpm args:audit`：连桌面版审参数漂移必须用 Electron 当 node 并把 `DSH_ROOT` 指到 asar（否则 `existsSync` 在 asar 上为 false → **静默 SKIP exit 0，等于没审**）；命令见 AGENTS.md
- `node scripts/locate-regress.cjs`（无 pnpm script）
- 手测清单（每个 vsix 必过）：连接常驻实例 ✓ 流式输出不卡（长回答不掉帧）✓ 审批卡应答后 DSH 侧确实继续执行（GUI 同屏验证闭环）✓ 点击看原生 diff ✓ 选区附加真实进 prompt（DSH GUI 侧看会话确认）✓ 手动杀 dsh 进程→重启→插件自动重连且会话内容对账不丢 ✓ 双窗口（或窗口+GUI）同时弹审批，一端应答后另一端自动撤卡 ✓
