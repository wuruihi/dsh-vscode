# 需求三·第二批 实施方案 v1（子代理面板 / 计划评审 / Goal 控制 / 后台任务 / Agent Teams / 旧 CLI 收尾）

> **审查对象**：本文件。审查标准见 §8。实施者需零上下文可读。
> **状态**：草案 v1（2026-09-30）→ 待独立子代理审查 → 按意见修订 → 用户确认 → 执行。
> **仓库**：`D:\03-Projects\Plugins\dsh-vscode`。**口径**：所有"实测"均为 2026-09-30 在本机（DSH 桌面版 0.2.0-rc.2 @19387）的**只读**观测；会话/子代理数量随时间变化。

---

## 0. 目标与建议范围

第二批的本质与第一批相同：**桌面版升级后，插件里有几处功能其实已经"静默失效"**，另几处是本体有、插件没有的洞。

| # | 做什么 | 性质 | 代价 |
|---|---|---|---|
| 4 | **子代理面板真修复**：数据源改用 `session/list` + 父会话 `subagentCatalog` 投影；中断改用 `subagents/interruptByParent` | 修坏（抽屉在 0.2.0 恒空） | 中 |
| 5 | **计划评审链路验证/修复**：确认 0.2.0 的计划评审提问能被插件完整应答，不通则改用 `userQuestions/answer` | 验证 + 可能修 | 低 |
| 6 | **Goal 控制**：GoalBar 加暂停 / 继续 / 完成 / 清空 / 建目标（`goals/*`） | 补洞（现只读） | 低 |
| 7 | **后台任务面板**：`job/list` 是**流式**端点，接上它 + `job/kill` | 修坏（0.2.0 上很可能恒空，同"归档"那类） | 中 |
| 8 | **Agent Teams 编队抽屉**：`agentTeam` 投影（成员 + 任务）只读展示 | 补洞 | 中高 |
| 9 | **旧 CLI 删除后的收尾**：文档与提示文案（用户 2026-09-30 自删 `C:\Users\wurui\dsh`）；**不删代码** | 收尾 | 低 |

**建议先做 4 + 6 + 7 + 9，5 顺带验证，8 视你兴趣单独排**——理由：4/7 是"功能已经坏了"，6 只读变可控且成本最低，9 只要十分钟；8 是新界面，投入最大而你现在主要在 DSH 本体里管编队。
**明确不做**：编队控制（加/减成员、派任务；本批只读展示）、`session/search` 全文检索（第一批已定）、改 DSH 配置、任何系统配置变更。

---

## 1. 事实基础（实测，2026-09-30）

**F1 端点（0.2.0 描述符 + 内层 schema 实测）**

1. `subagents/interruptByParent` args ＝ **平铺三键** `{childSessionId, parentSessionId, mode}`，其中 `mode` 的 schema 是 `literal("continuable")` —— **只接受这一个值**（我曾试 "cancel"/"interrupt"，均 `gateway/input-invalid`）。
2. `subagents/prompt` args ＝ `{request}`（request 包裹），request 类型名 `SubagentPromptRequest`（内层字段未取到，见 §3 T4 的确认步骤）；回执 `{messageId}`。
3. `subagents/list` **已移除**（0.2.0）——插件 `client.ts:237` 命中 `subagentsListUnsupported` 后返回 `{entries: []}`，**子代理抽屉因此在 0.2.0 上恒为空**。
4. `goals/create` ＝ `{agentId, request:{objective, maxGoalRounds?}}`；`goals/edit` ＝ `{agentId, ref, request:{objective?, maxGoalRounds?}}`；`goals/pause|resume|complete|clear` ＝ `{agentId, ref}`；`ref` 的 schema ＝ `{id, revision}`；`goals/get` ＝ `{agentId}`（无目标时 `ok:true` 且 `value` 为空）。
5. `job/list`、`job/follow` 都是 **stream 端点**（一元直调 `job/list` → `gateway/signature-invalid: stream Remote methods must be opened through the stream carrier`）。`job/follow` request ＝ `{sessionId?, jobId, from?}`；作业项含 `output:{total, earliest, spillPaths?}`。`job/kill` ＝ `{request}`。
6. `userQuestions/answer` ＝ **平铺** `{agentId, callId, answer:{answers:[{id, selected:[…], custom?}]}}`；`userQuestions/attachWait` ＝ `{agentId, callId}`。

**F2 投影（`session/projections` 实测返回 20 个键）**

- 键全集：`title, goal, tokenUsage, contextPressure, contextBreakdown, inbox, sessionStats, turnOutline, agentPreset, userQuestions, subagentCatalog, subagentTiming, subagent, agentTeam, permissions, todos, plan, modelSelection, sessionListMetadata, imageLimits`。
- `subagentCatalog` 实测值：`[{id:"fc1b2cd5…", mode:"continuable", label:"Audit VSCode extension internals", createdAt:…}, …]` ← **子代理列表的权威来源**。
- `agentTeam` 实测值：`{members:[{id:"session-246fce77…", name:"lead", role:"lead", phase:"active"}], tasks:[]}`。
- `goal` 投影已含 `{id, revision, objective, phase, maxGoalRounds, blockedReason?}`（`app.tsx:1948` 的 GoalBar 已在用）⇒ **`ref` 可直接从投影取**。
- `sessionStats` ＝ `{turns, steps, llmMs, toolMs, ttftMs, …}`；`turnOutline` ＝ `[{turn, seq, prompt, response}]`；`userQuestions` ＝ `{active:[], settled:[]}`；`plan` ＝ `{active, pending}`。

**F3 现有代码锚点**

1. `src/session/manager.ts:739 listSubagents()` → `subagent.list`（v012 映射 `subagents/list`，已移除）→ 空列表 + 一次告警；`client.ts:237-241` 是降级点。
2. `manager.ts:753 subagentHistory(childId)` → `session.history`（**可用**，子代理就是一个 session）；`manager.ts:764 subagentPrompt(childId)` → `session.prompt` 指向 child（既有工作路径）；`manager.ts:780 subagentInterrupt(childId)` → `session.cancel` 指向 child。
3. `manager.ts:991` 处理 `type === "session/jobs" || "jobs"` 的 mux 负载并 post `{t:"jobs"}` —— **v012 上没有产生这种负载的流**（`remote.ts` 无对应订阅）⇒ 0.2.0 上后台任务面板极可能恒空（T7 第一步实测确认）。
4. `webview/src/protocol.ts` 已有 `subagent-prompt` / `subagent-interrupt` / `list-subagents` / `subagent-history` 消息（Phase 2 已铺），`app.tsx` 的 `drawer === "subs"` 抽屉与 `subView` 转录 Sheet 已存在；`{t:"jobs"}` 已有渲染（`drawer === "jobs"`，`app.tsx:860` 附近）。
5. GoalBar 在 `app.tsx:1948` 附近，只读渲染 `goal` 投影。

**F4 环境**：本机旧 CLI（`C:\Users\wurui\dsh`，0.1.5-rc.1）**已被用户删除**（2026-09-30）⇒ 插件状态栏的"旧实例"候选探测不到；`args:audit` 现在只覆盖桌面版 asar；`docs/design.md` §3.5 与 `AGENTS.md` 连接路线仍以"两套共存"为前提。

---

## 2. 改动面总览

| 文件 | 改动 |
|---|---|
| `webview/src/protocol.ts` | 新消息：`subagents`（改用新条目形状，替换现有 `{kind,id,mode,…}`）、`goal-result`（操作回执/错误）、`jobs` 增加 `spillPaths` |
| `src/session/manager.ts` | `listSubagents()` 改用 `session/list` + 投影；`subagentInterrupt()` 改用 `subagents/interruptByParent`；新增 `goalAction()`；新增 `followJobs()`（打开 `job/list` 流）与 `killJob()` |
| `src/connection/remote.ts` | 新增 `job/list` 流的打开/转发（会话切换时重开） |
| `webview/src/app.tsx` | 子代理抽屉渲染新条目（mode/label/running/`agentAvailable`）；GoalBar 加四个操作按钮 + 建目标入口；任务面板显示 `spillPaths` 可点；新增「编队」抽屉（`agentTeam`） |
| `webview/src/styles.css` | 上述新增按钮/徽标样式 |
| `docs/design.md` | 新增 §3.7（子代理 / Goal / 任务流 / 编队投影契约）；§3.5 补"旧 CLI 已移除"注记 |
| `AGENTS.md` / `docs/roadmap.md` / `CHANGELOG.md` | 连接路线注记、第二批状态、v0.19.3 记录 |
| `scripts/*` | 视 T5-T7 结论补回归用例（至少：GoelBar 操作的 ref 组装、job 流的帧解析） |

---

## 3. 任务

### T4 子代理面板真修复（中）

**文件**：`src/session/manager.ts`、`webview/src/protocol.ts`、`webview/src/app.tsx`

- 步骤 1：`listSubagents(sessionId)` 改为**双源**：
  - 主源：`call("session.list", {})` 的行里 `origin === "subagent" && parentSessionId === sessionId`，取 `{sessionId, running, agentAvailable, projections.values.title}`；
  - 富源：父会话 `call("session.projections", {request:{sessionId}})` 的 `subagentCatalog`（`{id, mode, label, createdAt}`），按 `id` 与主源合并（`label` 优先取 catalog）。
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
          mode: catalog.get(r.sessionId)?.mode ?? "continuable",
          label: r.projections?.["values"]?.["title"] ?? catalog.get(r.sessionId)?.label ?? r.sessionId.slice(0, 8),
          activity: r.running ? "running" : "idle",
          hasChildren: false,
        }));
      this.host.post({ t: "subagents", sessionId, entries });
    } catch (err) { /* 告警 + 空列表，保持既有降级形态 */ }
  }
  ```
- 步骤 2：`subagentInterrupt(childId)` → 先试新端点、失败回退旧路径：
  ```ts
  await this.lifecycle.client.call("subagents.interruptByParent", {
    childSessionId: childId, parentSessionId: this.currentSession, mode: "continuable",
  });
  ```
  （`mode` 只能是 `"continuable"`，F1-1；`parentSessionId` 用当前会话。失败 → 回退 `session.cancel{childId}` 并记录一次日志，不静默。）
- 步骤 3：`subagentPrompt` 保持 `session.prompt`-on-child（**已是工作路径**），但在注释里记录替代路径与确认步骤：
  > 若将来 child 不可 prompt 或需要正式的父子语义，改用 `subagents/prompt {request}`；其 request 内层字段需先从 asar 确认：`node_modules/@deepseek-ai/dsh-subagent/lib/*.js` 中搜 `SubagentPromptRequest` 的 `z.object({...})` 定义（本方案未取到，故不在本批切换）。
- 步骤 4：webview 抽屉渲染新条目（mode 徽标 `continuable`/`one-shot`、运行点、label），空态文案改为「该会话暂无子代理」。

**验收**：本机实测——打开一个真实有子代理的会话（如 `session-246fce77…`，实测 70 个子代理行中多属它）的抽屉，**能看到条目且非空**；点一个 continuable 子代理 → 转录非空；`subagentInterrupt` 用真实子代理触发→ 收到成功或明确的错误提示（不允许静默）。

### T5 计划评审链路验证（低）

**文件**：`src/session/manager.ts`（必要时）、`docs/design.md`

- 步骤 1：**先验证**：在 0.2.0 上触发一次计划模式（或在 `plan` 投影 `{active:true}` 的会话里），确认插件的提问卡能完整显示「计划评审」并在应答后解除。判据：`question/requested` 帧到达 + 应答后 `question/resolved`。
- 步骤 2：若 `respond()`（`$events/result` 载体，实测通路可用）能完成应答 → **本项无需改码**，只把结论写进 `design.md §3.7`。
- 步骤 3：若应答不生效（计划卡不解除），改走 `userQuestions/answer` 平铺端点：`{agentId: sessionId, callId: rpcId, answer:{answers:[{id, selected, custom?}]}}`（形状 F1-6 实测）。
- 步骤 4：验收记录（成功路径 + 使用端点）写入 CHANGELOG。

**验收**：一次真实的计划评审在插件里走完（或明确记录"0.2.0 上计划评审未复现，留待用户手测"——不允许含糊）。

### T6 Goal 控制（低）

**文件**：`src/session/manager.ts`、`webview/src/protocol.ts`、`webview/src/app.tsx`

- 步骤 1：宿主新增：
  ```ts
  async goalAction(action: "pause" | "resume" | "complete" | "clear", ref: { id: string; revision: number }): Promise<void> {
    const method = `goals.${action}`;
    try {
      await this.lifecycle.client.call(method, { agentId: this.currentSession, ref });
      this.host.post({ t: "goal-result", ok: true, action });
    } catch (err) { this.host.post({ t: "goal-result", ok: false, action, error: errText(err) }); }
  }
  async createGoal(objective: string, maxGoalRounds?: number): Promise<void> {
    await this.lifecycle.client.call("goals.create", { agentId: this.currentSession, request: { objective, ...(maxGoalRounds ? { maxGoalRounds } : {}) } });
  }
  ```
- 步骤 2：**`ref` 从 `goal` 投影取**（投影含 `id`/`revision`；`app.tsx` 已持有 `goalData`）⇒ webview 直接 `post({t:"goal-action", action, ref:{id, revision}})`。
- 步骤 3：GoalBar 右侧加「暂停/继续」（按 `phase` 二选一显示）、「完成」、「清空」（二次确认）、以及无目标时的「建目标」（输入 objective → `goal-create`）。
- 步骤 4：回执处理：`ok:false` → 通知条；`ok:true` → 等投影刷新（投影是权威，不做乐观本地状态）。

**验收**：真机——建目标 → GoalBar 出现；暂停 → 徽标变 paused；继续 → 恢复；完成/清空 → 消失；`revision` 不匹配时提示（服务端会拒）。

### T7 后台任务面板（中）

**文件**：`src/connection/remote.ts`、`src/session/manager.ts`、`webview/src/protocol.ts`、`webview/src/app.tsx`

- 步骤 0（**先实测**）：确认 0.2.0 上任务面板是否真的空（打开 `drawer === "jobs"`；同时查 `session/control` 帧里是否带 jobs）。若已有数据流 → 本项降为"补 spillPaths 展示"。
- 步骤 1：`job/list` 是流式端点（F1-5）⇒ 在 `remote.ts` 增加与 `session/control` 同构的订阅：会话切换时 `openStream("job/list", { request: { sessionId } })`（**request 内层字段需按 F1-5 同法先从 asar 的 `job_list_parameter_0$schema` 确认**；`job/follow` 的已知形状是 `{sessionId?, jobId, from?}`），把 baseline/增量帧转成 manager 的 `{t:"jobs"}`。
- 步骤 2：帧解析要宽松（铁律#2）：未知帧类型记一次日志、不抛出。
- 步骤 3：`job/kill`（`{request:{jobId}}`）接到面板上（每行一个「终止」按钮，二次确认）。
- 步骤 4：作业项 `output.spillPaths`（大输出落盘路径）渲染为可点文件（复用第一批的 `open-file` 语义）。

**验收**：真机——让 agent 起一个后台任务 → 面板出现该任务与状态；终态后状态更新；终止按钮生效；有 spill 的作业其路径可点开。

### T8 Agent Teams 编队抽屉（中高，视兴趣）

- 步骤 1：父会话 `session/projections` 的 `agentTeam`（F2）→ 新抽屉「编队」：成员表（`name` / `role` / `phase`）+ 任务列表（`tasks`）。
- 步骤 2：只读展示；`members[].id` 是 sessionId ⇒ 点击可 `switch`（复用既有消息）。
- 步骤 3：空态：「当前会话没有编队（Agent Teams 未启用或本会话未建队）」。

**验收**：真机——在一个有编队的会话（如本机 lead-only 的会话）里打开抽屉，至少显示 lead 成员；点击成员可切到该会话。

### T9 旧 CLI 删除后的收尾（低）

- 步骤 1：`docs/design.md §3.5` 与 `AGENTS.md` 连接路线加注："2026-09-30 用户已删除旧 CLI（`C:\Users\wurui\dsh`）⇒ 本机只剩桌面版实例；3080 候选与 `autoStart` 保留但当前无对象，重装旧 CLI 后自动恢复可用"。
- 步骤 2：提示文案复核：两处都不通时只提示「打开桌面版 App」，不再提"一键拉起旧版"（若该分支仍会尝试拉起不存在的 CLI，改为明确失败提示，不静默）。
- 步骤 3：**不删代码**（`instances.ts` 候选表、`autoStart` 分支保留）。

**验收**：`pnpm compile`；文案检索（`dsh-vscode` 输出里不再出现"一键拉起旧版"这类已失效承诺）；`pnpm regress:all` 全绿。

---

## 4. 验证与回归（逐条给结果）

| 命令 | 期望 |
|---|---|
| `pnpm compile` / `pnpm build` | exit 0；产物 `dist/extension.cjs` + `dist/webview.js` |
| `pnpm regress:all` | fold 24/24、fence 8/8、pathlink 8/8、locate ≥25/25（环境 skip 允许）、model 23/23、repair 14/14 |
| `pnpm args:audit`（桌面版 asar） | **0 处不匹配**；新增端点（`subagents/interruptByParent`、`goals/*`、`job/kill`）纳入覆盖点（预计 29 → 33+，以脚本实测为准） |
| `pnpm smoke --base-url http://127.0.0.1:19387 --from-credentials` | 14/14 保持；**不新增写端点探针**（避免真实状态变更），新增读取断言仅限 `session/projections` 键存在性 |
| 手测（用户，装 vsix 后 Reload Window） | T4 抽屉非空 + 转录 + 中断；T5 计划评审（或记录未复现）；T6 建/暂停/继续/完成/清空；T7 任务出现/终止/spill 可点；T8 编队成员可见 |

---

## 5. 风险与回退

| 编号 | 风险 | 处置 |
|---|---|---|
| R1 | `job/list` 请求内层字段未取到（只有 `job/follow` 的已知） | T7 步骤 1 先按同法从 asar 确认；字段不符则**先只做 spillPaths + 空态文案**，不硬编码猜测 |
| R2 | `subagents/prompt` 内层字段未取到 | 不切换（继续用 `session.prompt`-on-child），代码注释记录确认方法 |
| R3 | `subagents/interruptByParent` 只接受 `mode:"continuable"` | 常量写死并注释来源；失败回退 `session.cancel` |
| R4 | 子代理行数很大（本机 70 行，其中多为历史子代理） | 抽屉只列**当前会话的子代理**；列表来源已是内存里的 `session/list`，无额外往返 |
| R5 | Goal 操作与桌面版并发（同一 `~/.dsh`） | 全部以 `goal` 投影刷新为权威，不做乐观本地态；`ref.revision` 不匹配即报错 |
| R6 | 计划评审在 0.2.0 上的真实链路未复现 | T5 允许"记录未复现 + 留手测"，但**不允许**在未验证的情况下改应答路径 |
| R7 | 编队抽屉误读 `agentTeam` 为空对象 | 明确判空：`members` 非数组或为空 → 空态文案 |
| 回退 | 单项出问题 | 每任务一个 commit，`git revert <commit>`；无 schema/数据迁移、无系统配置改动 |

---

## 6. 文档与残留

- **文档先改**：`docs/design.md` 新增 §3.7（子代理双源 / Goal 操作与 ref / `job/list` 流式契约 / `agentTeam` 投影）+ §3.5 注记；`docs/roadmap.md` 第二批状态；`AGENTS.md` 连接路线注记与命令块（如需）；`CHANGELOG.md` v0.19.3。
- **残留**：本方案编写期的只读探针（`%TEMP%\dsh-batch2-*.mjs`）**已全部删除**；实施期新探针与测试会话收尾自清理（冒烟脚本已内建）。
- **不 push**；装 vsix 属系统配置变更（沿用既有授权，装前一句确认）。

---

## 7. 与第一批的关系

- 第一批已交付 v0.19.2（跨会话搜索 / 置顶归档含归档状态修复 / 交付物），其 `open-file`、`search-sessions`、`caps` 消息与本次 T7 的 spillPaths、T4 的抽屉共用同一套消息与语义。
- 本批**不修改**第一批任何已验收行为；子代理抽屉的消息形状变化只影响 `drawer === "subs"` 一处渲染。

---

## 8. 审查标准（给独立审查子代理）

**独立性要求**：只接收本文件；自行 read 代码 / 查 asar / 跑**只读**探针；**禁止**改文件、禁止写端点（`goals/*` 的写方法、`subagents/prompt|interruptByParent`、`job/kill` 一律不得调用）、禁止建会话、禁止 push、不得派生子代理。结论必须带可核查证据（文件:行号、命令、返回片段）。

**必查 7 项**：

1. **事实正确性**：§1 的 F1-F4 每条是否成立？行号漂移＝FAIL（给正确锚点）。特别核对 `subagents/list` 移除后的降级点、`manager.ts:991` 的 jobs 负载来源、`goal` 投影是否真的含 `id`/`revision`。
2. **协议契约**：`subagents/interruptByParent` 的 `mode` 常量、`goals/*` 的 `ref` 形状、`job/list` 为流式端点这三点是否与 asar 一致？T7 处理"流式 vs 一元"的方式是否与 `remote.ts` 既有 `session/control` 订阅同构？
3. **"是否真的坏了"的判定**：T4/T7 的"当前恒空/恒无数据"结论是否被证实（读码 + 只读观测）？有没有可能它们其实通过别的路径在工作（例如 `session/control` 帧里就带 jobs）？**这一项是本次审查的重点。**
4. **最简路径**：T4 的双源合并、T6 的按钮组、T8 的抽屉是否是最简实现？有没有既有消息/组件可直接复用（避免重复造）？
5. **可测性与验收**：§4 每条期望能否判真假？哪些验收是不可执行的口号？T5 的"允许记录未复现"会不会变成逃避验证的借口——给出更硬的判据。
6. **边界与遗漏**：至少检查——会话切换时 job 流是否重开/取消；子代理抽屉在无 `session/list` 权限/失败时的降级；Goal 操作在无目标时的按钮态；`agentTeam` 在非编队会话的空态；T9 文案是否真的还有"拉起旧 CLI"的失效承诺。
7. **红线与残留**：是否触碰系统配置/删除/push？本批**不得**调用任何写端点做验证（与第一批不同，批 2 的写端点会改变你的真实状态）——审查是否守住了这条？

**输出格式**：`维度 | PASS/FAIL | 证据 | 修改建议`；末尾给「必须修改（阻塞执行）」与「建议修改（可延后）」两张清单 + 一句话结论。