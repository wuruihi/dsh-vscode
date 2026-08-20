# dsh-vscode 设计文档（spec）

> 2026-08-17 立项。调研输入：dsh-vsc 0.1.13（反面教材）、Claude Code VSCode 2.1.235（交互蓝图）、用户自研 Obsidian 插件 deepseek-harness-native 0.1.3（协议考古）、DSH 0.1.0-rc.7 本体源码。

## 1. 目标与非目标

**目标**：在 VSCode 里获得与 DSH GUI 同等的 agent 协作体验，并把 VSCode 的编辑器上下文（选区/活动文件）真实喂给 agent，把 agent 的动作（diff/审批）翻译成 VSCode 原生交互。

**非目标**：
- 不做 agent 运行时（DSH 本体就是）
- 不自管 dsh web 实例、不做 broker（dsh-vsc 脆根因）
- V1 不做 IDE 能力反连桥（getDiagnostics 等是 V2）
- 不追求兼容多个 DSH 版本（锁定 rc.7+，宽松解析为演进留余地）

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
             │ http://127.0.0.1:3080/api/*
             │ ws://127.0.0.1:3080/api/events.mux + events.host
┌────────────┴───────────────────────────┐
│ dsh web（常驻，与 GUI 共享一切）        │
└────────────────────────────────────────┘
```

**关键架构决策**：

| 决策 | 理由 |
|---|---|
| fold 放 webview 侧，扩展宿主只转发原始事件 | postMessage 天然增量，规避 dsh-vsc 全量快照 O(n²) |
| 扩展宿主连协议，webview 不直连 | DSH 信任栅栏拒 webview Origin（Obsidian 版实测 403/1006） |
| 不依赖 DSH 内部包 | dsh-vsc require 内部 zod schema，DSH 升级即碎 |
| 复用常驻 3080 | 会话/插件（genui/agent-teams/workflow）与 GUI 共享，启动链最短 |

## 3. 协议契约（实测，来自 Obsidian 版考古 + rc.7 源码核对）

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

`host.describe`（探活）、`workspace.list`/`workspace.create{path}`、`session.list`/`session.create{workspaceId|cwd, agentPreset?}`/`session.prompt{sessionId, mode:"queue"|"steer", content:[{type:"text",text}|{type:"image",mediaType,data}], clientTimeZone?}`/`session.cancel{sessionId}`/`session.history{sessionId, maxMessages?, beforeSeq?}`/`session.models`/`session.selectModel{sessionId,provider,model,reasoningEffort?}`/`session.rename`/`session.updateQueue`

### 3.4 已知坑（必须内置对策）

1. 模型选择用 `m.id`，不用 `m.name`（大写 400）
2. workspace 路径归一化（`\`→`/`、大小写）再匹配，防误 create 报 ENOENT
3. 新建会话可能收不到 `session/subscribed`（rc.7 已在 session/created 推，仍保留 history 对账兜底）
4. 空轮（warmup）不算 turn 结束；`turn/end` 才收尾
5. runtime context 可能混在 assistant 输出 → stripSystemContext 清洗（沿用 Obsidian 版正则）
6. `usage`/`finish` chunk 是元数据，不渲染
7. 权限 projection 只推变化，初值用 `settings.describe` 补拉

## 4. 功能规格

### V1（本 spec 范围）

**F1 连接与生命周期**
- activate → `host.describe` 探活 3080（1s 超时）→ 连接；失败显示状态条 + "拉起 DSH" 按钮（Start-Process 脱离启动，轮询就绪 120s）
- 状态机：connecting / connected / disconnected / starting，状态条常显
- 断线指数退避重连（1s 起步，上限 30s），重连后全量对账

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
- `pnpm smoke`：连 3080 依次调 host.describe → workspace.list → session.create → prompt("回复 ok") → 收到 turn/end → cancel 清理，全绿
- 手测清单（每个 vsix 必过）：连接常驻实例 ✓ 流式输出不卡（长回答不掉帧）✓ 审批卡应答后 DSH 侧确实继续执行（GUI 同屏验证闭环）✓ 点击看原生 diff ✓ 选区附加真实进 prompt（DSH GUI 侧看会话确认）✓ 手动杀 dsh 进程→重启→插件自动重连且会话内容对账不丢 ✓ 双窗口（或窗口+GUI）同时弹审批，一端应答后另一端自动撤卡 ✓
