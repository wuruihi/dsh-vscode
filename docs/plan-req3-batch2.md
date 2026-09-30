# 需求三·第二批 实施方案 v2（子代理面板 / 计划评审验证 / Goal 控制 / 后台任务 / 旧 CLI 收尾）

> **审查对象**：本文件（v2 = 已按独立审查意见修订）。实施者需零上下文可读。
> **状态**：v1 → 独立子代理审查（7 维度 5 FAIL，10 条阻塞项 + 8 条建议）→ **v2 修订完成，待用户确认执行**。审查者的关键断言已由我**独立复核并实测**（见 §0.5）。
> **范围（用户 2026-09-30 裁定）**：本批做 **T4 + T5（验证）+ T6 + T7 + T-CLI**；**T8（Agent Teams 编队抽屉）延后单独排**。
> **口径**：所有"实测"为 2026-09-30 在本机 DSH 桌面版 0.2.0-rc.2 @19387 的**只读**观测。

---

## 0. 目标与本批的真实性质

**一句话**：桌面版 0.2.0 换掉了子代理与任务两条链路，插件里这两处**已经彻底失效**（不只是"列表空"）；本批把它们接到正确端点，另把 Goal 从"只读"变"可控"，并收尾旧 CLI 删除后的文档与文案。

| # | 做什么 | 性质 | 代价 |
|---|---|---|---|
| T4 | **子代理链路真修复**：列表（投影 + session/list）、**转录（子代理地址）**、追问（`subagents/prompt`）、打断（`subagents/interruptByParent`） | 修坏（4 条路径全失效） | 中 |
| T5 | 计划评审链路**验证**（判据已按审查加固；不通才改 `userQuestions/answer`） | 验证 | 低 |
| T6 | Goal 控制：暂停 / 继续 / 完成 / 清空 / 建目标 | 补洞 | 低 |
| T7 | **后台任务面板真修复**：`job/list` 流式接入 + 终止 + 大输出路径可点 | 修坏（0.2.0 永不进数据） | 中 |
| T-CLI | 旧 CLI 删除后的文案/文档收尾（**不删代码**） | 收尾 | 低 |
| T8 | Agent Teams 编队抽屉 | **延后**（实测 45/45 会话都是 lead-only，当前无价值） | — |

**明确不做**：编队控制、全文检索、改 DSH 配置、`queue` 帧改由 `inbox` 驱动（**登记待查**，见 §5-登记项）。

---

## 0.5 审查修订记录（v1 → v2）

### 必须修改（10 条，全部采纳）

| 项 | 审查结论 | 我的独立复核 | v2 落地 |
|---|---|---|---|
| **M1** | 子代理转录必须用**子代理地址**；插件现在用 session 地址必被拒 | **实测证实**：`session/page` 用 `{kind:"session",sessionId:<child>}` → `session/agent-busy: subagent Sessions require their durable parent address`；换成 `{kind:"subagent",parentSessionId,childSessionId,mode:"continuable"}` → 通过（走到业务层报 cursor 越界）。address union schema 亦已取出 | T4 步骤 1-2（client.ts `v012History` 增地址分支；remote.ts `snapshotOnce`/`openFollow` 参数化地址） |
| **M2** | `subagents/*` 必须升为**一级路径**；`session.prompt/cancel`-on-child 同属被拒族 | **schema 证实**：`subagents/prompt` request ＝ `{requestId, parentSessionId, childSessionId, mode:literal("continuable"), delivery:"queue"\|"steer", content:[…], clientTimeZone?}`；`interruptByParent` result ＝ `{accepted:true}`。v1 的 F1-2「字段未取到」与"已是工作路径"两处断言**均错** | T4 步骤 3-4 |
| **M3** | 条目 `activity` 必须是 `"active"`，否则打断按钮永不出现 | **读码证实**：`app.tsx:1160`/`1210` 判 `=== "active"` | T4 步骤 1 代码 |
| **M4** | `job/list` 帧型是 `{type:"rows",jobs}` 全量帧（无 baseline/增量）；请求＝`{sessionId}`；钩子要镜像 `desiredFollow` | **schema 证实**：`job_list_parameter_0 = {sessionId}`、`job_list_result = {type:literal("rows"), jobs:[…]}`；`remote.ts:297-316 openPersistentStreams()` 已有 `desiredFollow` 模式可镜像 | T7 步骤 1-2 |
| **M5** | goal 的 ref 在 `value.goal` 内层，不是投影顶层 | **schema 证实**：`goalProjectionSchema = {goal:{id,revision,objective,phase,blockedReason?,maxGoalRounds}, roundsStarted,…} \| null` | T6 步骤 2 |
| **M6** | §2 漏了 `src/extension.ts` 的入站分发（273-284）与 protocol 入站成员 | 读码证实（入站 `case` 是唯一分发点） | §2 表 + T6/T7 步骤 |
| **M7** | `args:audit` 只扫 `client.ts`/`remote.ts`，覆盖点最多 29→**30**，不是 33+ | 读码 + 今日实跑（29 点 0 漂移）一致 | §4 |
| **M8** | T5 的 `question/resolved` 判据不成立（该帧只在 `$events` 的 cancel 路径合成） | 读码证实（`remote.ts:421-426`） | T5 改为**三条同时成立**的判据 |
| **M9** | T9 验收目标串「一键拉起旧版」全仓 0 命中；真实失效承诺 11 处 | 我的检索一致（命中 0） | T-CLI 改白名单逐处确认 |
| **M10** | T8 不能只靠推投影（非当前会话 projection 被丢）；实测 45/45 会话都是 lead-only | 读码证实 `manager.ts:1003-1009` 只转发当前会话 | T8 已延后；若将来做，按"打开时按需拉投影 + 三态空态" |

### 被证伪的 v1 断言（14 条，已全部更正）
F1-2「prompt 字段未取到」｜F3-2「转录可用」｜「session.prompt-on-child 是工作路径」｜GoalBar 行号 1948（实为 2146 定义/696 使用）｜jobs 渲染行号 860（实为 1048-1079）｜「70 行多属该会话」（实测 6/71）｜「29→33+」｜「baseline/增量帧」｜R1（job 字段未知，实为已知）｜R2（prompt 字段未知⇒不切换，**必须切**）｜T6「ref 直接取」层级｜T8 空态前提｜T-CLI 目标串不存在｜T5 `question/resolved` 判据。

### 建议修改（8 条）
S1 T9 改号 **T-CLI**（roadmap #9 是第三批的定时提醒，避免撞号）｜S2 §0 与 roadmap「8 延后」对齐（已改）｜S3 catalog 的 `mode` 兜底用 `"unknown"`（合法值含它）｜**S4 登记待查**：`queue` 帧在 0.2.0 已消失（`remote.ts:355` 分支永不触发 ⇒ 队列条同样静默失效），可能应改由 `inbox` 投影驱动——**不在本批范围，但必须记录**｜S5 `design.md §3.3/§3.4` 补新端点与"子会话必须用子代理地址"这条知识｜S6 §4 smoke 行措辞（smoke 自身含自清理写路径）｜S7 手测若用真实状态变更，须在一次性会话做并 `goals/clear` + 跑 `session-purge.mjs` 收尾｜S8 `esbuild.mjs:44` 的日志文案过期（写入 v2 顺手修）。

---

## 1. 事实基础（v2：只留已证实项）

**F1 子代理链路（0.2.0）**

1. `subagents/list` **已移除** ⇒ `client.ts:237` 返回 `{entries: []}`，抽屉恒空。
2. **转录**：`session/page`/`session/follow` 的 `address` 是 union：`{kind:"session",sessionId}` 或 `{kind:"subagent",parentSessionId,childSessionId,mode:"one-shot"|"continuable"|"unknown"}`；对 `origin==="subagent"` 的会话，**session 地址必被拒**（实测错误串：`session/agent-busy: subagent Sessions require their durable parent address`），子代理地址通过。一份子代理的 `mode` 从父会话投影 `subagentCatalog[]` 取。
3. **追问**：`subagents/prompt` request ＝ `{requestId, parentSessionId, childSessionId, mode:"continuable", delivery:"queue"|"steer", content:[{type:"text",text}], clientTimeZone?}`，回执 `{messageId}`。
4. **打断**：`subagents/interruptByParent` args ＝ 平铺 `{childSessionId, parentSessionId, mode}`，`mode` schema 是 `literal("continuable")`（**唯一合法值**），回执 `{accepted:true}`。
5. **列表权威源**：`session/list` 行含 `origin`/`parentSessionId`/`agentAvailable`/`running`/`projections.values.title`（本机 98 行中 71 行为子代理行，分属 8 个父会话）；父会话 `session/projections` 的 `subagentCatalog` ＝ `[{id, mode, label, createdAt}]`，与行的 id 一致但 **label ≠ 行的 title**（catalog 是任务名，行 title 是提示词开头）⇒ 双源必要。

**F2 Goal（0.2.0）**

- `goal` 投影值 ＝ `{goal:{id, revision, objective, phase:"active"|"paused"|"blocked"|"complete", blockedReason?, maxGoalRounds}, roundsStarted, createdAt, updatedAt} | null`（GoalBar 读 `data?.goal`）。
- `goals/create {agentId, request:{objective, maxGoalRounds?}}`；`goals/edit {agentId, ref:{id,revision}, request:{objective?, maxGoalRounds?}}`；`goals/pause|resume|complete|clear {agentId, ref:{id,revision}}`；`goals/get {agentId}`（无目标 → `ok` 且无 value）。

**F3 后台任务（0.2.0）**

- `job/list`、`job/follow` 都是 **stream** 端点（一元直调 → `gateway/signature-invalid: stream Remote methods must be opened through the stream carrier`）。
- `job/list` request ＝ `{sessionId}`（单字段）；帧 ＝ `{type:"rows", jobs:[{id, kind, label, status, startedAt, finishedAt?, output:{total, earliest, spillPaths?}}]}`（**全量帧，无增量**）。
- `job/kill` ＝ `{request:{jobId, sessionId?}}`。
- **现状证死**：`remote.ts` 只开 4 条流（`session/follow`、`session/control`、`workspace/follow`、`$events`），无 `job/list`；`SessionControlFrame` 只有 `baseline`（value 仅含 projections）与 `projection` 两种，**不含 queue/jobs** ⇒ `manager.ts:991` 的分支与 `app.tsx:1048-1079` 的渲染在 0.2.0 上永不进数据。

**F4 计划评审 / 提问（0.2.0）**

- 应答载体 `$events/result` 可用（实测 HTTP 200 受理）；`userQuestions/answer` ＝ 平铺 `{agentId, callId, answer:{answers:[{id, selected:[…], custom?}]}}`；`userQuestions/attachWait` ＝ `{agentId, callId}`。
- 权威状态在投影：`userQuestions` ＝ `{active:[…], settled:[…]}`；计划评审的提问带 `intent.kind === "plan-review"`（`protocol.ts` 的 `QuestionCard` 已在建模）。

**F5 环境**：旧 CLI `C:\Users\wurui\dsh` 已被用户删除（2026-09-30）；`design.md §3.5` 与 `AGENTS.md` 仍以"两套共存"为前提；`args:audit` 现在只覆盖桌面版 asar。

---

## 2. 改动面总览

| 文件 | 改动 |
|---|---|
| `src/connection/client.ts` | `v012History` 增**子代理地址**分支（`parentSessionId`+`subagentMode` 存在时用 `{kind:"subagent",…}`）；新增 `subagents.prompt` / `subagents.interruptByParent` / `goals.*` / `job.kill` 的方法映射（落在 client 内以便被 `args:audit` 计入） |
| `src/connection/remote.ts` | `snapshotOnce` / `openFollow` 的地址参数化（接受字符串或 `{sessionId,parentSessionId,mode}`）；新增 `desiredJobs` + `openJobList(sessionId)` + `jobsHandle`，在 `openPersistentStreams()` 与 `follow()` 里 cancel/重开（镜像 `desiredFollow`） |
| `src/session/manager.ts` | `listSubagents()` 双源重写；`subagentHistory()` 传父会话与 mode；`subagentPrompt()` 改走 `subagents.prompt`；`subagentInterrupt()` 改走 `interruptByParent`（legacy flavor 才回退 `session.*`-on-child）；新增 `goalAction()` / `createGoal()` / `killJob()`；`follow()` 处触发 job 流 |
| **`src/extension.ts`** | **入站分发补 3 个 case**（`goal-action` / `goal-create` / `job-kill`）；T-CLI 的提示文案调整（148/150/164/182/189） |
| `webview/src/protocol.ts` | 入站成员 +3；`subagents` 条目类型对齐（`activity:"active"｜"idle"`，`mode`，`label`）；`jobs` 条目加 `spillPaths?`；新 `goal-result` |
| `webview/src/app.tsx` | 子代理抽屉渲染对齐（`"active"`、mode 徽标）；GoalBar 三态按钮 + 建目标；任务面板 `spillPaths` 可点 + 终止按钮 |
| `webview/src/styles.css` | 新增按钮/徽标样式 |
| `docs/design.md` | 新增 §3.7（子代理地址与 `subagents/*` 契约 / job 流 / goal 操作）；§3.3 补端点；§3.4 补"子会话必须用子代理地址"；§3.5 注记旧 CLI 已移除 |
| `AGENTS.md` / `docs/roadmap.md` / `CHANGELOG.md` / `esbuild.mjs` | 连接路线注记、第二批状态（S1/S2）、v0.19.3 记录、过期日志文案（S8） |

---

## 3. 任务

### T4 子代理链路真修复（中）

**文件**：`src/connection/client.ts`、`src/connection/remote.ts`、`src/session/manager.ts`、`webview/src/{protocol.ts,app.tsx}`

- 步骤 1（列表，双源）：
  ```ts
  async listSubagents(sessionId: string): Promise<void> {
    try {
      const [list, pj] = await Promise.all([
        this.lifecycle.client.call<{ items: SessionRow[] }>("session.list", {}),
        this.lifecycle.client.call<{ values?: { subagentCatalog?: { id: string; mode: string; label?: string }[] } }>(
          "session.projections", { request: { sessionId } },
        ).catch(() => ({ values: undefined })),
      ]);
      const catalog = new Map((pj?.values?.subagentCatalog ?? []).map((c) => [String(c.id), c]));
      const entries = (list?.items ?? [])
        .filter((r) => r.parentSessionId === sessionId)
        .map((r) => ({
          id: r.sessionId,
          mode: catalog.get(r.sessionId)?.mode ?? "unknown",   // S3：合法值含 unknown
          label: catalog.get(r.sessionId)?.label ?? titleOf(r) ?? r.sessionId.slice(0, 8), // catalog 是任务名，行 title 是提示词
          activity: r.running ? "active" : "idle",             // M3：渲染端判 "active"
          hasChildren: false,
        }))
        .sort((a, b) => Number(b.activity === "active") - Number(a.activity === "active"));
      this.host.post({ t: "subagents", sessionId, entries });
    } catch (err) {
      // 用户可见降级（不是空注释）
      this.host.post({ t: "notify", kind: "warn", message: `子代理列表获取失败：${errText(err)}` });
      this.host.post({ t: "subagents", sessionId, entries: [] });
    }
  }
  ```
  另存 `private subagentModes = new Map<string, string>()`（childId → mode），供转录/追问复用。
- 步骤 2（转录，**子代理地址**）：`client.ts` 的 `v012History` 增分支：
  ```ts
  const address = payload.parentSessionId
    ? { kind: "subagent", parentSessionId: payload.parentSessionId, childSessionId: payload.sessionId, mode: payload.subagentMode ?? "unknown" }
    : { kind: "session", sessionId: payload.sessionId };
  ```
  `remote.ts` 的 `snapshotOnce`/`openFollow` 同步接受该地址（不再硬编码 `kind:"session"`）；`manager.subagentHistory(childId)` 从 `subagentModes` 取父会话与 mode 一起传。
- 步骤 3（追问，一级路径）：
  ```ts
  await this.lifecycle.client.call("subagents.prompt", {
    request: { requestId: makeRequestId("subprompt"), parentSessionId: this.currentSession, childSessionId: childId,
      mode: "continuable", delivery: "queue", content: [{ type: "text", text }] },
  });
  ```
  仅 `flavor === "legacy"` 时回退 `session.prompt`-on-child。
- 步骤 4（打断）：`subagents.interruptByParent {childSessionId, parentSessionId: this.currentSession, mode: "continuable"}`；legacy 回退 `session.cancel`。**`mode` 写成常量并注明来源**（schema `literal("continuable")`）。
- 步骤 5：webview 抽屉渲染对齐（`activity === "active"` 才显示打断按钮；mode 徽标）。

**验收**：真机——打开父会话抽屉见条目（本机可用 `session-246fce77…`，6 个子代理）；点 continuable 子代理**转录能出来**（关键：修好前必报 `session/agent-busy`）；追问有回执与转录更新；打断一个运行中的子代理 → 成功或明确错误，**不允许静默**；`pnpm compile` 通过。

### T5 计划评审链路验证（低）

- 步骤 1：在 0.2.0 上触发一次计划模式提问（或在 `plan` 投影 `active:true` 的会话里复用），**三条同时成立**才算通过：
  1. `respondQuestion()` 的 `$events/result` 回执 `accepted === true`（非"无 value 视为成功"的宽松判定）；
  2. 该会话 `session/projections` 的 `userQuestions.active` 中该 `callId` 消失、对应项 `state → "continued"`；
  3. 随后一个回合**恢复产出**（新 `assistant/message`）。
- 步骤 2：若三条不全成立 → 改用 `userQuestions/answer {agentId, callId, answer:{answers:[{id, selected, custom?}]}}` 并重跑三条判据。
- 步骤 3：结论（成功路径 + 所用端点 + 原始证据片段）写入 CHANGELOG；**不允许**写"未复现"就收工——若无法在 0.2.0 上复现计划评审场景，必须明确写出"未复现的原因 + 留给用户手测的具体步骤"。

### T6 Goal 控制（低）

- 步骤 1：宿主（`manager.ts`）+ 入站分发（`extension.ts`）：
  ```ts
  async goalAction(action: "pause" | "resume" | "complete" | "clear", ref: { id: string; revision: number }): Promise<void> {
    try {
      await this.lifecycle.client.call(`goals.${action}`, { agentId: this.currentSession, ref });
      this.host.post({ t: "goal-result", ok: true, action });
    } catch (err) {
      this.host.post({ t: "goal-result", ok: false, action, error: errText(err) });
    }
  }
  async createGoal(objective: string): Promise<void> {
    try {
      await this.lifecycle.client.call("goals.create", { agentId: this.currentSession, request: { objective } });
      this.host.post({ t: "goal-result", ok: true, action: "create" });
    } catch (err) {
      this.host.post({ t: "goal-result", ok: false, action: "create", error: errText(err) });
    }
  }
  ```
- 步骤 2（**ref 层级，M5**）：webview 从 `goalData?.goal` 取 `{id, revision}`：`post({t:"goal-action", action, ref:{id:g.id, revision:g.revision}})`。
- 步骤 3：GoalBar 三态——**有 goal**：显「暂停」（`phase==="active"`）或「继续」（`phase==="paused"`）、「完成」、「清空」（二次确认，`phase!=="complete"`）；**goal 为 null**：显「建目标」（输入 objective）。`blocked` 相位只显示 blockedReason（操作按钮仅留「清空」）。
- 步骤 4：回执→通知条；成功不写本地乐观态（等 `goal` 投影刷新为权威）。

**验收**：真机（**在一次性会话里做**，收尾 `goals/clear` + purge）——建目标→GoalBar 出现；暂停→徽标 paused；继续→恢复；完成/清空→消失；对 `goal=null` 会话点操作不会出现（按钮不渲染）；`revision` 过期时服务端拒绝并出提示。

### T7 后台任务面板真修复（中）

- 步骤 1（`remote.ts`，镜像 `desiredFollow`）：
  ```ts
  private desiredJobs: string | undefined;
  private jobsHandle: StreamHandle | undefined;
  follow(sessionId) { ...; this.desiredJobs = sessionId; this.openJobList(sessionId); }
  private openJobList(sessionId: string): void {
    this.jobsHandle?.cancel();
    this.jobsHandle = this.openStream("job/list", { request: { sessionId } }, {
      onItem: (value) => {
        const f = value as { type?: string; jobs?: unknown[] };
        if (f?.type !== "rows") { warn(`[v012] job/list unexpected frame: ${String(f?.type)}`); return; }  // 铁律#2：记一次，不抛
        this.opts.onMux({ rpcId: "", payload: { type: "session/jobs", sessionId, jobs: Array.isArray(f.jobs) ? f.jobs : [] } });
      },
      onError: () => warn(`[v012] job/list error for ${sessionId}`),
    });
  }
  ```
  `openPersistentStreams()` 里加 `this.jobsHandle?.cancel(); if (this.desiredJobs) this.openJobList(this.desiredJobs);`。
- 步骤 2：`job/kill`（`{request:{jobId}}`）→ 面板每行「终止」+ 二次确认；成功/失败都出通知。
- 步骤 3：作业项 `output.spillPaths` 渲染为可点文件（复用第一批 `open-file` 语义），并显示 `output.total`。
- 步骤 4：空态文案改为「当前会话没有后台任务」；未知帧类型只记日志（不打断面板）。

**验收**：真机——让 agent 起一个后台任务 → 面板出现且状态变化；终态后更新；「终止」生效；有 spill 的作业路径可点；**修好前该面板恒空**（对照证据：`remote.ts` 无 job 流）。

### T-CLI 旧 CLI 删除后的收尾（低，原 T9）

- 步骤 1：文案白名单逐处确认（M9 实测清单）：`extension.ts:148`（`启动本地 dsh web（旧版）` 按钮）、`:150`（提示串）、`:164`、`:182`、`:189`、`lifecycle.ts:253-255`、`design.md:128/148`、`package.json:102/107`、`README.md:29-31`。**做法**：仅当 `locateDsh()` 能解析出 CLI 时才提供"启动旧版"入口；解析不到就只给「打开桌面版」/「选择实例…」，并在提示里说明"本机未检测到旧版 CLI（已删除可忽略）"。
- 步骤 2：**不删代码**：`instances.ts` 的 3080 候选、`autoStart`、`lifecycle.startDsh` 全部保留（重装旧 CLI 即自动恢复）。
- 步骤 3：`design.md §3.5` 与 `AGENTS.md` 连接路线加注：「2026-09-30 用户已删除旧 CLI ⇒ 本机只剩桌面版；候选/兜底代码保留」。
- 步骤 4（S8）：修 `esbuild.mjs:44` 过期日志文案（`extension.js` → `extension.cjs`）。

**验收**：逐处确认无失效承诺（检索**源码 + 文档**，排除 CHANGELOG 历史留痕）；`pnpm compile`；`pnpm regress:all` 全绿；真机点一次"没有实例"路径，提示里不再出现需要旧 CLI 的动作。

---

## 4. 验证与回归（期望值为实测口径）

| 命令 | 期望 |
|---|---|
| `pnpm compile` / `pnpm build` | exit 0；产物 `dist/extension.cjs` + `dist/webview.js` |
| `pnpm regress:all` | fold 24/24、fence 8/8、pathlink 8/8、locate ≥25/25（环境 skip 允许）、model 23/23、repair 14/14（**全部不得回退**） |
| `pnpm args:audit`（桌面版 asar） | **0 处不匹配**；覆盖点 **29 → 30**（新增 `job/list` 流开帧；其余端点若按 §2 落在 `client.ts` 则再 +N，**以脚本实跑数字为准**，不预先写死 33+） |
| `pnpm smoke --base-url http://127.0.0.1:19387 --from-credentials` | 14/14 保持；新增断言仅限**只读**（`session/projections` 含 `subagentCatalog` / `agentTeam` 键；`job/list` 作为流能开且收到 `{type:"rows"}`）。**不新增写端点探针** |
| 手测（用户，装 vsix 后 Reload Window） | T4：抽屉非空 + **转录能出** + 追问 + 打断；T5：计划评审（或按 §T5 步骤 3 的具体步骤）；T6：建/暂停/继续/完成/清空（一次性会话 + `goals/clear` + purge）；T7：任务出现/终止/spill 可点；T-CLI：无实例时的提示不含失效动作 |

---

## 5. 风险与登记项

| 编号 | 风险/登记 | 处置 |
|---|---|---|
| R1 | 子代理地址的 `mode` 若与真实不符（`one-shot`/`continuable`/`unknown` 三选一） | 从 `subagentCatalog` 取；取不到用 `"unknown"`（合法值）；转录失败时**回退提示**而不是静默 |
| R2 | `subagents.prompt` 对非 continuable 子代理会拒 | 只对 `mode === "continuable"` 显示追问入口；`one-shot` 只读转录 |
| R3 | job 流随会话切换的 cancel/重开漏掉 → 串台 | 镜像 `desiredFollow`；切换即 `cancel` + 重开；`onItem` 不校验 sessionId 就转发视为缺陷 |
| R4 | 手测写真实状态（goal、kill） | 一次性会话 + `goals/clear` + `session-purge.mjs`（S7） |
| R5 | `queue` 帧在 0.2.0 已消失（`remote.ts:355` 永不触发）⇒ **队列条同样静默失效** | **本批不改**，作为登记项写入 `design.md §3.7` 与 roadmap（下一步候选：由 `inbox` 投影驱动） |
| 回退 | 单项出问题 | 每任务一个 commit，`git revert`；无 schema/数据迁移、无系统配置改动 |

---

## 6. 文档与残留

- **文档先改**：`design.md` §3.3/§3.4/§3.5/§3.7（S5）、`roadmap.md`（第二批状态 + 队列条登记）、`AGENTS.md`（连接路线注记）、`CHANGELOG.md`（v0.19.3）。
- **残留**：本方案编写期与复核期的只读探针（`%TEMP%\dsh-b2-*.mjs`、`dsh-batch2-*.mjs`）**已全部删除**；实施期新探针与一次性会话收尾自清理。
- **不 push**；装 vsix 属系统配置变更（沿用授权，装前一句确认）。

---

## 7. 与第一批的关系与增量复核要求

- 第一批已交付 v0.19.2（`open-file`、`search-sessions`、`caps` 语义、baseline 三字段）。本批复用其 `open-file`，**不修改**其任何已验收行为。
- 本批 v1 → v2 的修订点：T4（地址 + `subagents/*` + activity 值）、T5（判据）、T6（ref 层级 + 守卫）、T7（帧型 + 钩子）、T-CLI（白名单）、§2（`extension.ts`）、§4（覆盖点 30）。
- **审查者要求"按 M1–M10 修订后增量复核"**；我已对 M1/M2/M3/M4/M5 做了**独立实测复核**（证据在 §0.5 与 §1）。增量复核范围建议＝**修订点（上列 7 处）+ 上轮 FAIL 项**，不再全量重审。