# 更新记录（CHANGELOG）

> 扩展 ID：`wurui.dsh-web-vscode`（display: DeepSeek Harness (DSH)）
> 市场名 `dsh-web-vscode`（`dsh-vscode` 在市场被他人占用）；仓库 GitHub `wuruihi/dsh-vscode`。
> 约定：每个版本一个 vsix 本地安装验证；市场发布按批次手动上传，未必逐版本。

## v0.18.1 — 底栏缓存命中率（GUI 对齐）+ 输入口径修正

- **缓存命中百分比**：底栏 token 统计行新增 `缓存命中 88%`，公式 = cacheReadTokens / (cacheReadTokens + uncachedInputTokens)。公式与口径全部实证校准：本体 GUI 底栏渲染 `缓存命中 91% | 输入 3.7M tok · 输出 58.1K tok`（browser-act 实读）+ 实时 wire 快照 tokenUsage={uncached:487647, cacheRead:3560960, output:69909} 反推 88.0% 一致
- **输入口径修正（顺手 bug）**：旧代码"输入"显示的是 uncachedInputTokens（仅未命中部分，如 487K），本体显示的是总输入（cached+uncached，如 4.0M）——量级差 ~8 倍，已对齐为总输入
- **紧凑格式**：token 数显示 K/M 缩写（4.0M tok），与本体一致；零值不显示（新会话底栏不出现"缓存命中 NaN%"）
- 排查路径存档：宿主 0.1.2 鉴权（token→cookie）后 /api/events.mux 废弃、改单 /api/remote.mux 流端点；RPC 斜杠端点 + {args:{_request:{}}} 包装；usage 原始块 {inputTokens, outputTokens, totalTokens, cacheReadTokens}

## v0.18.0 — 项目级钉死默认模型（provider/model）

- **需求**：宿主新会话默认=全局最近使用模型，跨项目串味（公司项目开新会话拿到个人付费模型，烧个人额度）。v0.5.2 的工作区"最近使用"记忆挡了大部分，但有两个口子：首次无记忆回落宿主全局；误操作一次污染记忆
- **新设置 `dsh-vscode.defaultModel`**：格式 `"provider/model"`（可选第三段 reasoningEffort），写在各项目的 `.vscode/settings.json` 即天然按项目隔离（公司项目钉公司 provider，个人项目钉个人 provider）。新会话应用优先级：**钉死设置 > 本项目最近使用 > 宿主全局**
- 钉死应用成功弹 info 确认（"已应用本项目默认模型：provider/model"）；应用失败（模型下线/写错）弹 warn 并退回最近使用，**不清除设置**（用户手写的配置不自动删）；格式错误弹 warn 忽略
- 注意：仅覆盖插件内新建会话；DSH GUI 里建的会话仍走宿主全局逻辑（上游能力，本地不 patch 宿主）

## v0.17.0 — 工作区分组管理（P2 主任务收官）

- **真数据源切换**：工作区 Sheet 从「按 cwd 假分组」升级为**服务器真实工作区**（workspace/follow 快照基线，实测拿到 D:\bywork 等真实分组与成员）；未收录进任何工作区的会话落入「未分组」
- **分组管理五件套**：重命名（行内编辑，Enter 保存）/ 上移下移重排（workspace.insertBefore 锚点语义）/ 删除分组（两步确认；会话不删，归入未分组）/ ＋新建工作区（VSCode 目录选择器 → workspace.create）/ 会话移组（行内目标分组选择 → workspace.insertSessionBefore）
- **通道事实**：workspace/list 无 HTTP 路由（读=流快照）；五个写端点全部在线（伪 id 探针 → arguments-invalid=端点存在仅 id 格式不过）——读走流、写走 HTTP 的混合模式与 subagent 相反，各自实证为准
- **验证**：compile/build 零错误；fold 9/9 + fence 8/8 + repair 14/14；vsix 282KB 已装机

## v0.16.0 — 子代理面板：追问 + 打断（P2 主任务）

- **交互**：子代理对话 Sheet 底部新增固定输入条（sticky）——输入消息回车/点发送即追问该子代理；子代理运行中（activity=active）时输入条左侧出现红色「打断」按钮；操作后自动刷新对话
- **通道考古（关键纠偏）**：竞品的 subagent.history/prompt/interrupt 三个 RPC 在 alpha.5 网关上**已不存在**（HTTP 404；WS 流载体重试报 invalid Remote endpoint / unary cannot be opened through stream carrier）——正确通道是「子会话本身就是 session」：session.history（走我方 snapshot/page 适配层）/ session.prompt（mode:queue + content 数组）/ session.cancel，全部指向 childId。伪 id 零污染探针验证 schema（session/cancel → session/not-found 业务错=参数合法）
- **教训入账**：竞品的 RPC 名只能当线索不能当事实——它绑的是 rc.x 时代端点；每个方法都要在当前网关上实测存活性
- **验证**：compile/build 零错误；fold 9/9 + fence 8/8 + repair 14/14；vsix 281KB 已装机

## v0.14.0 — 运行中发送键变红色停止键 + v0.13.0 前七版本 git 入库

- **停止按钮（用户需求）**：AI 执行期间（本会话 running），输入框右下角发送圆钮变为红色「停止」方块钮，点击即发 cancel 结束当前回合（与 Esc 同效），停止后输入框立即可发下一条；空闲时自动还原为发送键
- **git 入库**：v0.6.0→v0.13.0 七个版本全部 commit（此前 25 文件未入库的资产风险清零；仅 commit 未 push）
- **情报入账**：用户确认竞品 jager 0.12.89 在 alpha.5 部署上已死（面板空白、无会话列表）——竞品绑定旧协议无自适应层。对标阶段结束，后续按自身节奏演进

## v0.15.0 — 设置面板：schema 驱动服务器设置表单（P1 主任务）

- **新设置 Sheet（⚙ 按钮）**：右侧宽 Sheet 内直接查看/修改 DSH 服务器设置，不再跳 VSCode 设置页。数据源 settings/describe（实测 14 个命名空间，schemastery 序列化 schema）
- **表单渲染**：每命名空间一张可折叠卡（名称 + 「即时生效/需重启」徽章 + 未保存计数）；字段按 schema 类型渲染——string/number/boolean 输入控件、const 只读、secret/credential-ref 只显「🔒已配置/🔓未配置」（凭据值永不下发到面板）、嵌套对象只读 JSON
- **保存**：settings/update {ns, patch, expectedRevision}（乐观锁，竞品同款 wire；空 patch 探针实证写通道）；只传变更字段；保存成功自动刷新 describe（revision 递增）；失败红条报错
- **数值链**：user 覆盖 → 实时值 → base → schema 默认；底部保留「扩展自身设置 → VSCode 设置页」入口
- **验证**：compile/build 零错误；fold 9/9 + fence 8/8 + repair 14/14 + auth 真机全过；settings 写通道空 patch 探针 ok；vsix 280KB 已装机

## v0.13.0 — 历史正文丢失根因修复（chunkrow）+ 侧栏面板交互对齐竞品（右侧 Sheet）

- **问题 1 根因（历史重放丢正文）**：实测当前会话 6678 条历史事件——实时流的 text-delta/reasoning-delta 在持久层被压缩为 `chunkrow/text-chunks` / `chunkrow/reasoning-chunks`（data.texts[] 数组），历史里 3474 条 assistant/chunk 仅含 block/tool-call/usage/finish 帧、**不含任何文本增量**。fold 未处理 chunkrow → 重载后全部正文/思考消失（最终「以上」回复缺失即此因）。修复：fold 新增两个 case，texts 按序拼接进 segments；fold-regress 补 chunkrow 形状断言（9/9）；新增 scripts/fold-live.cjs 真实会话回放诊断脚本
- **问题 2（面板交互对齐）**：竞品源码实证（panels.ts + chat.css）：会话名下方工具钮点击 → **固定遮罩 + 右侧 Sheet**（400px/宽 620px，0.16s 滑入，Esc/点遮罩关闭，头部标题+控件+关闭钮）。我方五个抽屉（会话/工作区/任务/轨迹/子代理）全部重构为该交互
- **面板功能加深**：任务行加时钟+时长+detail 双行展示；轨迹表加时间列+回合分隔线（━ 回合 N ━）；子代理目录行**可点击打开只读对话**（新协议 subagent-history：manager 调 session.history 指向子会话 id，webview 用同一 fold 管线渲染，宽 Sheet 内返回目录）
- **明确未做（与竞品的剩余差距，待续）**：设置面板完整表单（竞品为 schema 驱动+模型供应商目录+发现模型+预设管理，我方仍跳 VSCode 设置页）；会话全文搜索（该部署 session.search 索引关闭）；子代理追问/打断（需 steer/interrupt 接线）；工作区分组管理（重排/归档分组）
- **验证**：compile/build 零错误；fold 9/9 + fence 8/8 + repair 14/14 + auth（真实服务器）全过；vsix 277KB 已装机

## v0.12.0 — 免 token 直连（credentials 铸 cookie，零配置 + 重启免疫）

- **问题**：alpha.5 起鉴权强制，启动 token 每次随机打印不落盘——用户（非技术背景）无从获取，服务器每次重启都断连。上一版的 authToken 手填方案对这类用户不可行
- **解法（线协议逆向）**：定位 dsh-client-connection 源码——服务器把 32 字节签名 secret 持久化在 `~/.dsh/.credentials.yaml` 的 `client-connection/browser-session` 记录里，且**跨重启复用**。cookie 格式完整复刻：名 `dsh-auth-`+base64url(sha256(authority))，值 `v1.`+base64url(payload)`.`+HMAC-SHA256 签名，payload={version:1,authority,issuedAt,expiresAt}（寿命 7 天 ≤ 服务端 30 天上限）。插件本地铸 cookie，**从此不需要 token**
- **auth.ts 发现链重排**：authToken 设置（显式意图优先）→ **credentials 铸造（新主力路径，零配置）** → 自有启动日志 → ~/.dsh 日志兜底；每级失败自动落下一级；401 时 invalidate 重铸（时间戳全新，天然免疫过期）
- **新增 src/connection/browser-auth.ts**：纯 node 模块（无 vscode 依赖，可独立回归）——readBrowserSecret/mintBrowserCookie/authorityOf/mintFromCredentialsFile
- **新增 scripts/auth-regress.cjs（真实服务器集成回归）**：真铸 cookie 打 3080 session/list（实测 200/211 会话）+ 篡改 secret 必须 401（证明服务器确在验签而非裸奔）
- **信任模型说明**：credentials 文件仅本用户可读，读它铸 cookie 与「从终端回滚里抄 token」同级信任，不构成越权
- **验证**：compile/build 零错误；auth-regress 3/3（真实服务器）+ fold 9/9 + fence 8/8 + repair 14/14；vsix 275KB 已装机。用户侧效果：**Reload 后会话列表自动恢复，什么都不用填，服务器重启也不断**

## v0.11.0 — 消息顺序/转圈根因修复 + 0.1.2-alpha.5 兼容性体检

- **兼容性体检（用户 DSH 升级 alpha.5 后）**：隔离实例（deepseek-harness 检出同版本）全套 smoke **12/12 通过**——探测/鉴权/remote.mux/$events/session 全链路/模型目录。Phase 0 双协议层兑现「持续升级不返工」的设计目标。结论：**插件在 alpha.5 上可用**，唯一变化：alpha.5 强制鉴权且 token 每次启动随机打印、不落盘 → 磁盘发现链失效，**authToken 设置成为主通道**（横幅文案已更新说明）
- **工具卡永久转圈（根因修复）**：实测线协议（rc.2 真实历史捕获）：tool/result 的 callId 埋在 `data.message.source.callId` / `data.message.content[0].toolCallId`，结果文本在 `content[0].content[0].text`——fold 原先只读顶层 `data.callId`（恒为空），finishTool 永远匹配不到。修复：resultCallId 三级宽松取值 + 嵌套 preview 提取 + finishTool 跨回合回溯兜底（结果落在 turn/end 之后的边缘乱序也能落定）
- **消息交错顺序（架构修复）**：TurnItem 新增 `segments` 交错序列（text/thinking/tool 按真实到达顺序），渲染以 segments 为唯一事实源——「一句话→read→思考→一句话→edit→pwsh」与 GUI/竞品同序呈现；text/thinking/activities 保留为同步平面视图（复制/统计零改动）；旧数据走 fallback 拼接
- **step 持久事件 + 工具图标**：step/start|end（真实历史里是 persistent 事件，原先被忽略）映射为步骤卡；工具行按名称映射线条图标（read→eye edit→edit grep→search pwsh→ledger web→globe 子代理→box），label 去 emoji 前缀改等宽字体，卡片独立缩进 14px
- **新增回归 scripts/fold-regress.cjs**：以实测线形状为 fixture（嵌套 callId/嵌套文本/交错块/step 事件/legacy 顶层数形状），9/9 通过——此前无任何 fold 层回归，这次的形状断言永久化
- **验证**：compile/build 零错误；fold-regress 9/9 + fence 8/8 + repair 14/14（护城河零改动）+ alpha.5 smoke 12/12 + rc.2 smoke 11/11；vsix 273.6KB 已装机

## v0.10.0 — 面板工具面补齐（用户面板对比反馈）

- **头部功能行五钮**（会话行下、工具行内，drawer 机制统一开合）：
  - 📁 **工作区**：会话按目录分组 + 标题搜索 + 每行归档；归档区展示诚实跳过（rc.2 session.list 不下发 archived 标记）
  - 📒 **后台任务**：session/jobs 事件帧驱动的任务台账（状态五色点 running/stopping/completed/killed/failed），零新增 RPC——mux 全帧本就在收，manager 补转发；终止仍由 agent job_kill 完成（与网页端同款约束）
  - 🧭 **轨迹**：事件台账视图——history+实时帧留存 rawEvents（cap 800），类型筛选 + 点击展开完整 JSON，协议调试利器
  - 📦 **子代理目录**：subagent.list（rc.2 点式）/ subagents/list（0.1.2 request 包裹）双 flavor 路由，实测返回 {entries:[{id,mode,label,activity,hasChildren}]}
  - ⚙️ **设置**：打开 VSCode 扩展设置页（MVP；面板内完整设置表单=竞品 settings/describe 体系，按需后置）
- **输入框 ＋ 添加菜单**：文件/文件夹/图片三入口——原生 picker（宿主 pickPaths，rel 相对工作区根）→ file chips；文件夹引用宿主展开为浅层目录清单（[引用目录 … 共 N 项]）；图片走既有 base64 通道
- **/ 命令按钮**：slash 功能此前只有键入 / 触发（不可发现）——现工具行常驻按钮，一键弹出命令+技能列表（同管道同缓存）
- **底部统计中文化**：out/in/cache → 输出/输入/缓存命中
- **验证**：compile/build 零错误；fence 8/8 + repair 14/14；legacy smoke 11/11；rc.2 实测 subagent.list/settings.describe/session.search 支持面（search 因部署索引关闭不可用→改客户端过滤）；vsix 272.3KB 已装机

## v0.9.0 — Phase 2 次批：goal 进度卡 + 队列编辑/插队

- **goal 进度卡（双 flavor，协议无关）**：goal 走 `session/projection`（key="goal"），manager 全键转发本就生效——本轮补齐消费端。投影形状实线捕获（本会话目标直读）：`{goal:{id,revision,objective,phase,maxGoalRounds,blockedReason?},roundsStarted}`；phase ∈ active|complete|paused|blocked（GUI dsh-client-ui-goal 源码证实，blocked 显示 blockedReason.message）；历史切换时从 session.list 投影种子恢复。头部下方 dock 药丸条：◎ 目标文本（截断+title 全文）+ 阶段徽标 + 轮次 x/max；四态配色（进行中 accent / 完成绿 / 暂停灰 / 受阻橙）
- **队列编辑与插队（updateQueue 动作全集 edit|remove|steer）**：动作集从 alpha.4 typert.host.js schema 逐字提取；rc.2 支持面用零污染探测法证实（伪 sessionId 三动作全过 schema 到 queue-item-not-found）；队列 chip 新增 ✎ 编辑（内联 textarea，Ctrl+Enter 保存 / Esc 取消）与 ↺ 插队（steer：转为引导消息立即影响当前轮）；steering 项不再显示插队钮
- **验证**：compile/build 零错误；fence 8/8 + repair 14/14；legacy smoke 11/11（含 updateQueue 三动作探测）；vsix 268.4KB 已装机
- Phase 2 至此收官（语法高亮/图片按钮/未读点/goal 卡/队列编辑全落地）；delta 合并下发（纯性能项）移入 Phase 3 按需

## v0.8.0 — Phase 2 首批：代码语法高亮 + 图片按钮 + 未读点

- **代码语法高亮（双方此前都无，补齐即代差）**：`code.tsx` 新组件——highlight.js core + 20 语言子集（ts/js/json/python/bash/powershell/css/html/md/sql/yaml/diff/java/go/c/cpp/c#/rust/php/ini）+ 40 别名表（tsx/sh/py/yml/…），未知语言诚实回退纯文本；调色板映射 VSCode Dark+ 令牌色，body.vscode-light 自动切换亮色；代码块带语言标签条 + hover 复制按钮。接入点在 markdown.tsx 的 pre/code 两处微创（分割器与 dsh-ui 回退零改动，fence 8/8 + repair 14/14 守绿）
- **图片按钮**：composer 工具行新增 🖼 按钮（file picker，多选，走现有粘贴路径：>20MB 拒绝 / 4 格式 / base64 直发）
- **会话列表未读点**：非当前会话 running→idle 翻转标记绿点，切换即清（回合结束检测，不依赖新协议消息）
- **验证**：compile/build 零错误；fence 8/8 + repair 14/14（护城河仍零改动）；legacy smoke 11/11；vsix 266.3KB（webview +105KB 为高亮子集）已装机

## v0.7.0 — Phase 1：视觉对齐（竞品 MIT 设计系统移植，React 重实现）

- **新增 `icons.tsx`**：竞品 ICONS 线条图标表全量移植（30 path，24×24 / stroke 1.8 / currentColor，亮暗主题自适应），MIT 署名；emoji 图标（✎ ⑂ 🗄 ＋ ➤ ⏳ ✅ ❌）全部替换
- **`styles.css`**：`:root` 增 9 个 `--dsh-*` 令牌 + color-scheme；composer 改 Codex 风格卡片（14px 圆角 / focus-within 变 accent / 输入 min72-max320 透明内嵌 / 34px 圆形发送钮）；msg-user 右对齐 max-92% + 14px 圆角；msg-role 10px 大写角色行（你 / DSH）；工具卡 10px 圆角 + 14px 内联缩进 + 三态色（蓝转/绿成/红败 + 失败红边）；审批红系 / 提问蓝系
- **新增 UI 元素（app.tsx）**：头部两行（会话行 + 工具行：🌐 浏览器打开 + ＋ 新建）；回合分隔 999px 药丸（「⑂ 第 N 轮」，点击=从此分叉）；每轮产物卡（accent 边框，diff/edit view.locations 推导，点击打开文件）；回合操作条（复制 / 👍 / 👎）；底部常驻统计行（轮数 · 工具数 · token 用量）+ 上下文压力条（4px 三档 teal→warm→hot）；turn-status 脉冲点 + 计时
- **fold.ts（非护城河）**：TurnItem 增 produced/lastSeq/turnNo；产物推导=成功 mutation 的 view.locations（网页端 ProducedFiles 语义，读/删/失败不计，首见去重）
- **新消息**：open-file（宿主解析相对路径后打开编辑器）、open-browser、fork-at{atSeq}（药丸+操作条共用，manager.forkSessionInternal 支持定点分叉）、feedback（日志留痕，RPC 接入留 Phase 2）
- **验证**：compile/build 零错误；fence 8/8 + repair 14/14（dshui/markdown/修复管线零改动红线守住）；legacy smoke 11/11（协议层无回归）。手测清单见 roadmap Phase 1 验收段
- 设计原则不变：**移植设计系统，不抄像素**——令牌/间距/状态色对齐，React + 备忘渲染架构原样

## v0.6.0 — Phase 0：双协议自适应层（0.1.1-rc.x + 0.1.2+ 同时兼容）

- **背景**：DSH 0.1.2 线协议断代（斜杠端点 + `{args}` 信封 + 单 WS `remote.mux` + token 换 cookie 鉴权 + `session/page` 分页 + `modelCatalog`），用户持续升级 DSH 到最新版——协议适配成为 P0。docs/design.md §1 非目标中「锁定 rc.7+」策略作废，改双 flavor 探测切换（§3.0）
- **新增 `src/connection/protocol.ts`**：连接时探测（先 `session/list` 404/失败回退 `session.list`/`host.describe`），401/403 也识别为 v012；流层连续 3 次断线重探（服务器中途升级自动跟随）；不可识别 → 横幅不静默死循环
- **新增 `src/connection/remote.ts`**：V012Streams——单 `remote.mux` WS 多路逻辑流（open/cancel/item/end/error），把 v012 帧在连接层合成为 legacy 形状 mux payload（session/event、queue、projection、approval/question 卡）——**manager 与 webview 零改动消费两种服务器**；follow 游标 + 一次性 snapshot（历史尾页）
- **新增 `src/connection/auth.ts`**：token 发现（设置 `dsh-vscode.authToken` → 插件拉起日志 `~/.dsh/dsh-vscode-web.log` → `~/.dsh` 日志扫描）→ `GET /?token=` 换签名 cookie；401 自动刷新重试一次。**实测：token 只在 dsh web stdout，外部终端启动无日志可扫 → authToken 设置兜底**
- **`client.ts` 重写为 flavor 路由**：全部端点改名/参数适配收在一张表里。**实测坑（alpha.4 实机）**：args 必须逐参数精确匹配——单 request 方法包 `{request:{…}}`、`session/list` 要 `_request:{}`、`agent` 参数 wire 名 `agentId`、`commands/execute` 的 `images` 必填传 `[]`、流开帧同样包装（`session/follow` → `{request:{address}}`）。竞品 apiClient 平铺传参，在真实 alpha.4 上会被网关拒绝——未照抄
- **验证**：legacy 链路 smoke 11/11（rc.2 实机 3080）；v012 链路 smoke 12/12（alpha.4 隔离实例 `DSH_HOME=%TEMP%` 3081，含探测/鉴权/remote.mux/$events/workspace 流/session 全链/分页快照/prompt 流式/turn end）；fence 8/8 + repair 14/14（渲染护城河零改动）
- 附带：竞品分析 `docs/competitor-analysis.md` + 路线图 `docs/roadmap.md`（Phase 1 视觉对齐 → Phase 2 特性 → Phase 3/4 大项）

## v0.5.13 — 项目级钉死默认模型（provider/model）

（注：本特性实际随 v0.18.0 发布——0.5.13 开发期间并行会话已推进至 0.17.0，版本号让路）

- **需求**：宿主新会话默认=全局最近使用模型，跨项目串味（公司项目开新会话拿到个人付费模型，烧个人额度）。v0.5.2 的工作区"最近使用"记忆挡了大部分，但有两个口子：首次无记忆回落宿主全局；误操作一次污染记忆
- **新设置 `dsh-vscode.defaultModel`**：格式 `"provider/model"`（可选第三段 reasoningEffort），写在各项目的 `.vscode/settings.json` 即天然按项目隔离（公司项目钉公司 provider，个人项目钉个人 provider）。新会话应用优先级：**钉死设置 > 本项目最近使用 > 宿主全局**
- 钉死应用成功弹 info 确认（"已应用本项目默认模型：provider/model"）；应用失败（模型下线/写错）弹 warn 并退回最近使用，**不清除设置**（用户手写的配置不自动删）；格式错误弹 warn 忽略
- 注意：仅覆盖插件内新建会话；DSH GUI 里建的会话仍走宿主全局逻辑（上游能力，本地不 patch 宿主）

## v0.5.12 — badcase 7：裸组件根且丢 type，字段签名推断补壳

- **形态**：`{"title":"核心判断","tone":"info","content":"…"}`——callout 的字段全在，但既没壳 `items` 也没 `type`。normalizeRoot 只认"带已知 type 的裸组件"，此形态穿透 → 渲染失败卡
- **修法（无歧义原则延续）**：壳的合法字段仅 title/gap/panel/append/items——**组件独有字段出现在根上不可能是合法壳**。字段签名表：rows+columns→table、pairs→keyvalue、steps→steps、tone+content / title+content→callout、label+href→link、label+tone→badge、裸 content→text（最弱，垫底）。命中即注入 type 并包壳；`{title:"…"}` 这类纯壳字段对象不误伤（原样透传，渲染层诚实降级）
- 回归 14 用例（badcase 7 原文逐字 + 签名表抽查 + 无假阳性守门），双套件 22/22

## v0.5.11 — 会话列表去子代理污染 + 父行子代理徽标

- **badcase**：agent 派的子代理会话（用户发起或 AI 自主）混进插件会话列表，与主会话并列，用户困惑"哪条是我的对话"。GUI 里子代理挂在会话名下（"n 个子代理"可下钻），插件此前平铺
- **wire 实证**（探针 session.list）：子代理会话带 `origin:"subagent"` + `parentSessionId`，与主会话同 cwd——所以穿透了工作区过滤器
- **修复**：列表隐藏 origin=subagent 行（会话列表=用户自己的对话，子代理是 agent 的工人，不可切换）；父会话行显示徽标「🔧 n」（有进行中的显示 r/n 高亮），信息不丢；标题后台探测也跳过子代理行（省无效 session.history 调用）。子代理内容详情仍归 DSH 本体会话页（插件暂不做下钻）

## v0.5.10 — 跨会话提问/审批卡归属徽标

- **背景**：工作区级弹卡设计（其他会话的提问在你正在看的会话里弹出）缺归属标注——用户报告"在会话 B 看到 A 的提问，误认成 B 的问题"。方向不变（后台会话提问静默停摆的代价 > 误认一眼的代价），补齐归属
- **SourceBadge**：非当前会话的提问/审批卡顶部显示「🔔 来自会话《标题》· 切换 →」，点击直接切到来源会话；当前会话自己的卡不显示（不加噪音）。标题取自会话列表缓存，未命名回退"未命名会话"
- 会话互通模型澄清（用户疑问）：卡片跨会话弹 ≠ 会话上下文互通——agent 间共享走的是工作区文件（memory 日志等），会话上下文彼此隔离不变

## v0.5.9 — badcase 6：合法 JSON 的裸组件根 + 补齐 file-tree 渲染器

- **形态层（新坏形类）**：模型把组件对象本身当围栏根输出（`{type:"file-tree", items:[…]}`，合法 JSON、直接 parse 成功）——此前修复管线的裸组件包壳只挂在"parse 失败"路径上，合法 JSON 短路了它；组件层把树节点（type:"dir"/"file"）当组件渲染，全部落空 → 白屏。**normalizeRoot**：壳规范中根永远不带 `type`，故"直接 parse 成功 + 根带已知组件 type"是无歧义裸组件信号 → 包壳 `{items:[v]}`；裸组件数组同理包壳；纯非组件数组（如字符串数组）无歧义意图 → 诚实降级
- **组件层（缺件补齐）**：file-tree 此前根本未实现（未知类型降级代码块）——新增可折叠树渲染器（目录默认展开、子节点计数徽标、超长业务名换行不溢出）
- 回归套件增至 11 用例（badcase 6 原载荷逐字 + 裸组件数组 + 字符串数组拒绝），harness 新增 "reject" 断言语义；双套件 19/19

## v0.5.8 — 诚实化 not-pending 提示（事故复盘产物）

- **背景**：一次"插件应答不生效"的事故复盘发现，not-pending 回执的提示文案写死归因"连接重连过"——但该回执最常见的成因其实是"问题已被其他客户端应答"（GUI 弹窗、其他插件窗口、自动化探针抢答）。误导性归因让用户把"已被答掉"误读成"没答上"，掩盖真实链路状态
- **修复**：提问/审批两处提示改为如实陈述："该提问已失效：可能已被其他窗口应答或已超时；若 DSH 仍在等待会弹出新的提问卡"
- 链路本身经双向探针实证无恙：应答提交（裸回执 accepted）+ question/resolved 广播撤卡（面板与本体同步消失，用户面板实测确认）

## v0.5.7 — 对齐 dsh 0.1.1-rc.2（图片链路 + 提问卡 + 拉起行为）

- **图片接收渲染**（此前只有发送、没有渲染，历史里的图一律不可见）：rc.8 起宿主把会话日志里的图片改为持久化引用 `{type:"image", attachment:{attachmentId,…}}`——webview 侧 fold 提取引用，按需经扩展宿主调新 RPC `session.attachment` 拉字节（协议知识仍只在 src/connection，架构规则不破），LRU 缓存 32 张跨 re-fold 复用；pre-rc.8 内联 base64 形状直接渲染（重启宿主前后都能显示图）；点击缩略图放大/还原；拉取失败降级 🖼✕ 占位
- **一键拉起加 `--no-open`**：rc.8 起本地 `dsh web` 启动会自动开浏览器，插件拉起场景下是干扰（用户已在面板里），拉起命令显式抑制
- **提问卡多行输入**：自定义回答 input → textarea（可多行、可拉高），对齐 GUI rc.1 行为
- **修多选题渲染 bug**：wire 字段实为 `multiSelect`，旧代码读 `q.multi`——多选题一直被渲染成单选（选一项就清另一项）；实测 rc.2 的 AskUserQuestionItem 类型定案
- **plan-review 意图识别**：提问项新增 `intent:{kind:"plan-review", approve}` 展示意图——识别后渲染「📋 方案审阅」标记 + plan markdown 滚动区 + 批准选项绿色高亮；不识别时按通用选项渲染也安全（协议不变，纯展示层）
- **detail 字段渲染**：普通提问的 detail 以 muted 小字展示（此前整个丢弃）
- 协议面对照验证（dsh-host-apiproxy rc.2 类型声明 + dsh-client-connection 网关源码）：扩展所用 17 个 RPC 方法、WS 帧联合、respond 裸回执、PromptContentPart 逐字段兼容，无破坏

## v0.5.6 — 对齐本体引号修复 + GUI 修复链实证对照

- **实证对照**（genui 插件源码逐函数拆解 + 五条 badcase 实测）：GUI 的修复链为"提取+截断候选(G)→未转义引号/尾逗号(xn)→括号栈删错闭符/补开符(Sn)"，对我们的五条 badcase **全部无解**（xn/Sn 实测返回 null）——GUI 依赖截断渲染（丢内容）或客气降级提示；"本体从不失败"是选择偏差（坏消息都在插件会话，未在 GUI 打开过）+ 失败死得体面 + 生成侧 validate_dsh_ui 工具拦截
- **补齐唯一覆盖缺口**：移植 GUI 的未转义引号启发式（闭引号后跟 `,]}/:` 或结尾=真终止，否则转义）——中文内容「说"你好"啊」类形态此前我们会降级、GUI 能修，现已对齐；同趟顺带覆盖尾逗号
- 回归套件增至 8 用例（新增引号/尾逗号两条），双套件 16/16

## v0.5.5 — 复合坏形修复：数组内裸键值对 + 提前闭 root 叠加

- **badcase 5**：模型把 items 第二个元素的开头 `{` 丢了——callout 完整结束后，`"type":"table","columns":…,"rows":…` 键值对裸飘在数组里（数组成员不能是键值对，非法 JSON）；且该载荷结尾 `]]}` 少了 items 的闭合 `]`——与 badcase 1"提前闭 root"叠加成复合坏形
- **新修复级 `wrapBareMembers`**：字符串感知栈扫描，检测"元素位置的 `"key":` 对"（无歧义形态：合法 JSON 中数组元素绝不可能以键值对开头），补 `{` 包壳、在数组 `]` 或下一元素前补 `}`；扫描器看不懂的形态返回 null 降级，不猜
- **级联编排**：balanceClose 补完缺 `]` 后对再平衡文本重跑 wrap——两个修复级可组合，覆盖复合坏形
- **回归套件** `scripts/repair-regress.cjs`（6 用例，含本 badcase 原文逐字），与切分层套件 `fence-regress.cjs` 并列；JSON 修复层从此有独立回归门

## v0.5.4 — 修复插件应答提问/审批不生效

- **现象**：插件里回复提问，提示"已在其他端处理"，但 GUI 里问题仍待答，必须去 GUI 答才生效
- **根因一（回执误读）**：实测探针证明 `/api/respond` 返回裸回执 `{"accepted":true}`（无 server-response 信封），client 按信封路径解析恒失败——每次应答都被误报"已在其他端处理"
- **根因二（重连换 rpcId）**：宿主每次断线重连会用**新的 rpcId** 重发未答提问（mux replay "live rpcId"）；插件旧卡挂着旧 id，作答命中 not-pending，真实答案从未到达会话
- **修复**：①回执按裸格式解析；②连接代际边界撤下全部待答卡（重发回放会带回活的卡）；③同签名提问新 rpcId 到达时自动换卡；④失败提示如实（"卡片已过期请在新卡作答"），撤掉误导性的"已在其他端处理"
- 诊断方法沉淀：探针脚本挂 mux WS 复现插件原样信封 → 实测原始 HTTP 响应定案（结论先行于猜测）

## v0.5.3 — 广播事件工作区归属门（污染根治）

- **根因（第一性原理）**：宿主把每个会话的每类事件（提问/审批/投影/队列）广播给所有连接的客户端，没有按 workspace 的订阅概念——客户端各自为政的守门留下三个缺口（提问、审批、投影），四类跨项目污染（提问弹错窗口、todo 串台、会话列表混项目、默认模型跨项目）全是同一缺口的不同出口
- **统一守门 `ownsSession`**：一个判定函数管全部广播通道——会话是当前会话（本窗口建/领养）或其 cwd 匹配本工作区根目录才放行；提问卡、审批卡现在只弹在**自己项目**的窗口里
- **投影在源头收敛**：todos/plan/token/permissions 只转发当前会话的（0.5.1 的 webview 层守卫降级为双保险）；title 投影仍全量收（喂本工作区会话列表的标题缓存）
- **丢弃的安全性**：广播模型下每个客户端都有完整拷贝——归属客户端与 GUI（全项目视图）兜底显示，跨项目丢弃 ≠ 事件丢失；响应端原有对账（"已在其他端处理"）双端竞答安全

## v0.5.2 — 按项目记忆默认模型

- **新会话默认模型只在本项目内继承**：宿主原生行为是"全局最近一次会话的模型"——并行项目互相污染（在 B 项目用完模型 B，回 A 项目新开聊天也变成模型 B）
- 实现：本项目最后使用的模型存入 workspaceState（VSCode 原生按工作区隔离的存储）；新建会话时主动应用；首次使用（无记忆）才落到宿主全局默认
- 记忆来源两条：①在本插件里手动切模型 ②本项目真实会话（非空白）的当前模型；模型下架导致应用失败时自动清记忆自愈

## v0.5.1 — 三项会话隔离与输入框修复

- **跨会话投影污染**（真 bug）：todo/plan/token 推送不区分会话，其他会话（GUI、别的窗口）一动就覆盖当前面板——"任务明明完成了面板还显示一堆未完成"实为别人的清单。修复：非当前会话的投影推送直接丢弃
- **会话列表按项目过滤**（真 bug）：此前全量显示 dsh web 所有项目的会话；现在只显示 cwd 与当前工作区一致的会话（路径规范化比对，Windows 反斜杠/大小写安全）
- **输入框可拉高**：resize 一直开着但被 max-height:180px 锁死；放宽到视口 45%、最小 64px，拖右下角随意调

## v0.5.0 — dsh-ui 渲染架构重写（对齐 DSH 本体）

- **自研 fence 切分器**：dsh-ui 围栏不再交给 CommonMark 语义——渲染前用平衡扫描切分正文段/fence 段，开栏符粘在句尾、漏写闭合栏、栏内混正文等一切崩法统一进同一条管道（此前三个 markdown 层补丁全部删除，被本方案取代）
- **流式段落级稳定**：正文段 memo 化，流式增长只重解析尾部段（对齐本体 IncrementalMarkdownParser 的冻结思想）
- **回归测试套件** `scripts/fence-regress.cjs`：8 个用例覆盖全部已知崩法（含真实 badcase 原文），动渲染器必跑
- 背景调研：本体 GUI 亦有 JSON 失败降级分支（genui 插件），其优势在自研 micromark 管线 + fence 一等公民切分 + 增量解析；本次将插件架构对齐到同一原理

## v0.4.13 —（已被 0.5.0 取代）markdown 层围栏修复

- 开栏符粘正文句尾时拆行；漏闭合栏时在平衡 JSON 后补 ` ``` `
- 0.5.0 起由切分器统一实现

## v0.4.12 — 裸组件序列修复

- dsh-ui 修复器支持三种 root 形态：`{items:[…]}` 外壳 / 裸 `[组件]` 数组 / 裸组件序列（无外壳无分隔），后两者自动包壳
- 修 badcase：模型直吐三个按钮对象导致不渲染

## v0.4.11 — JSON 修复管线增强（两处）

- **括号平衡修复**：`}` 顶着未关数组（合法 JSON 不可能的形态，模型提前闭 root 漏关 items）→ 补 `]` 再关；上限 8 处
- **正文尾巴容忍**：root 完整有效时，栏后混入的非结构正文直接忽略
- 修 badcase：①重复 `rows` + 提前闭合 ②未闭合围栏吞正文

## v0.4.10 — 修复 `/` 技能菜单不加载

- 实测探明宿主 wire 层：skills 走 apiproxy `skill.list`（**单数**）`{sessionId}`；commands 走 typert 网关 `commands/list` `{args:{agentId}}`——GUI 内部服务名 ≠ HTTP API 名，跨层调用先打探针再写码
- 空列表 UI 区分三态：加载中 / 暂无可用技能 / 无匹配
- 同名时技能优先于命令

## v0.4.9 — Esc 中断 + Plan 指示 + Todo 进度

- **Esc 键**：弹层优先关闭 → 运行中中断 → 有草稿清空（对齐 Claude Code 肌肉记忆）
- **Plan 模式横幅**：琥珀色指示条 + 退出按钮（执行 `/plan off`），数据走 `plan` 投影，切换会话种子初始化
- **Todo 进度条**：`n/m` 计数 + 进度条 + 当前任务名，点击展开完整清单，数据走 `todos` 投影
- 三条信息条按 Plan > Todo > 运行状态排在输入框上方

## v0.4.8 — `/` 技能菜单

- 输入框行首打 `/` 弹出技能（🔧）+ 内置命令（⌘）清单，↑↓/Enter/Tab/Esc 键盘路由，60 秒缓存
- 技能选中插入 `/name ` 文本（宿主 pre-step 手势注入内容）；命令直接 RPC 分发
- 与 `@` 文件弹层互斥触发；普通路径/分数中的 `/` 不误触

## v0.4.7 — 注入过滤 + 溢出修复

- **指令注入不再显示**：`Instructions from AGENTS.md/CLAUDE.md` 头部的多段注入整条丢弃（此前逐段过滤只删头段留正文）
- **长文本不再撑破卡片**：`.dui`/`.assistant-bubble`/`.md` 根容器 `overflow-wrap:anywhere` + `min-width:0`；代码块和表格保留横向滚动（合理形态）

## v0.4.6 — 修复思考强度切换报错

- 强度选择器此前按模型 id 全局搜清单（跨 provider 同名模型撞库，把别家清单显示给当前模型）→ 改为 provider 优先匹配
- 副作用恰好正确：切到不支持思考强度的模型时选择器整个消失

## v0.4.5 — dsh-ui mermaid + plot 组件

- **mermaid 流程图**：自研 SVG 子集渲染器（不引 mermaid.js，包体仅 +2.5KB）——graph TD/LR、方/圆/胶囊节点、实/虚线/带标签边、最长路分层布局，解析失败降级代码块
- **plot 函数图**：白名单表达式编译（18 个函数）+ 200 点采样折线 + 自动 y 轴 + 图例，非法表达式拒绝执行
- 有意不做：quiz（场景不符）、scene3d（依赖过重）

## v0.4.4 — 用户气泡附件 chips

- 带文件附件的消息：气泡只显示用户的话，下方渲染 📎 文件名 chips，文件内容不进气泡
- 折叠层识别 `[引用文件 X]` 块抽标签丢正文——历史消息同样生效；纯附件消息可发送

## v0.4.3 — `@` 文件引用

- 输入框打 `@` 弹工作区文件补全（120ms 防抖 + reqId 对账防乱序；模糊匹配子串/子序列排序，最多 50 条）
- 选中变 📎 chip（多选/单删），正文 `@token` 自动清除
- 发送时协议携带 `{type:"file"}` 占位，宿主侧展开为真实文件内容块（2 万字符截断）——模型真能读到内容，非假引用

## v0.4.2 — 运行状态条移位

- "正在执行/思考中 + 停止"从面板顶部移到**输入框正上方**，阅读顺序：消息流 ↓ → 正在执行什么 → 输入框；样式改浅蓝轻条

## v0.4.1 — IDE 桥诊断过滤修复

- Windows 路径失配：诊断按文件过滤时反斜杠/小写盘符与 VSCode Uri 键不一致 → 过滤路径先 `Uri.file()` 规范化再 `toString()` 比对
- 实测发现的真 bug（道具文件 5 错误全报，按反斜杠过滤返回 0）

## v0.4.0 — IDE 能力桥（V2 核心功能）

- **模型获得 4 个 IDE 工具**：`ide_active_file`（对齐视线）/ `ide_selection`（读选区）/ `ide_diagnostics`（读报错）/ `ide_open_file`（打开定位到行）
- 架构：DSH 插件 `~/.dsh/plugins/dsh-ide-bridge`（defineTool）↔ HTTP 127.0.0.1:3187 + Bearer token（发现文件 `~/.dsh/dsh-vscode-ide.json`）↔ 扩展内置桥服务
- 安全：loopback + 随机 token + EADDRINUSE 静默退位（多窗口单服务）；两侧独立降级
- 验收：全链路实测通过（道具 TS 文件 5 个错误完整报出）

## v0.3.6 — 市场重发布

- 侧边栏图标 SVG 改 sanitizer-safe（纯实心 fill，去 fill-opacity/根级 fill="none"）
- 修复 v0.3.5 后侧边栏视图消失问题（SVG 保险 + VSCode 更新重置视图状态，右键边栏勾回）

## v0.3.5 —（未单列）侧边栏图标修复批次

- 鲸鱼图标上线后的视图消失排查与 sanitizer 修复

## v0.3.4 — 首个市场版本

- VSCode 客户端本体：连接本机 dsh web（127.0.0.1:3080），与浏览器 GUI 共享同一实例
- 会话：列表/切换/新建/重命名，双向同步
- 对话流：流式正文 + 思考折叠 + 工具卡片（live 指示 + FocusView 式折叠）
- 审批/提问卡：webview 内直接应答，多端并发自动收敛
- 上下文附加：Alt+K 选区/活动文件作为真实内容块（非 `@path` 假引用）；粘贴图片
- 原生 diff：编辑类工具卡"查看 diff"→ VSCode 原生 diff 编辑器（逆序反推原文，URI 版本号防陈旧缓存）
- queue/steer：运行中排队追加或中途引导，队列可见可删
- 模型选择：provider 分组 + reasoning effort
- 排版基线：中文 14px 下限、思考/工具折叠、气泡留白——对标 Claude Code 插件可读性

## v0.1.x – v0.3.3 — V1 阶段（未建档，2026-08-20 之前）

> git 仓库在 v0.3.4 才建立（首个 commit 即全量代码），此前版本未上架市场、无逐版本记录。以下按阶段粒度重建，明细到此为止——这也是本 CHANGELOG 存在的理由：版本记录从 v0.3.4 起只追加、不覆盖、不留黑洞。

- **起点**：替换第三方原型 `weinibuliu.dsh-vsc`（已卸载退役），自研 VSCode 客户端连接本机 dsh web
- **v0.1.x（最小可用）**：dsh web 连接与断线重连、会话列表/切换/新建、流式对话渲染、审批卡应答
- **v0.2.x（能力补齐）**：原生 diff 查看（编辑类工具卡）、queue/steer 运行中追加与引导、模型选择（provider 分组）、图片粘贴、`Alt+K` 上下文附加、会话标题缓存 + 并行补全的启动提速、上滑加载历史（视口锚定防跳动）
- **v0.3.0–0.3.3（排版打磨）**：对标 Claude Code 插件的可读性重排版（中文 14px 下限、思考/工具折叠、助手消息无气泡布局、remark-breaks 中文分段保真）、输入框右下角发送按钮、原创鲸鱼图标设计定稿
