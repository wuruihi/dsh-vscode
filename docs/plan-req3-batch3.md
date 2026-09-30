# 需求三·第三批 实施方案 v1（待发消息条修复 / 定时提醒管理）

> **审查对象**：本文件。审查标准见 §6。实施者需零上下文可读。
> **状态**：草案 v1（2026-09-30）→ 待独立子代理审查 → 修订 → 用户确认 → 执行。
> **仓库**：`D:\03-Projects\Plugins\dsh-vscode`。**口径**：所有"实测"为 2026-09-30 本机 DSH 桌面版 0.2.0-rc.2 @19387 的**只读**观测。

---

## 0. 范围与建议

| # | 做什么 | 性质 | 代价 |
|---|---|---|---|
| Q1 | **待发消息条（原队列条）修复**：`session/control` 在 0.2.0 只发 `baseline{projections}`，**没有任何 queue 帧** ⇒ 插件里"排队消息"永远不显示。改由 `inbox` 投影驱动 | 修坏（第三处同类静默失效） | 低中 |
| Q4 | **定时提醒管理**：面板列出 / 删除（+ 可选：查看历史），`schedule/list {request:{sessionId}}`、`schedule/delete {request:{id,sessionId}}`、`schedule/catalog {}` | 补洞（你在用 schedule） | 中 |

**延后（本批不做，连理由）**：消息点赞点踩（`messageFeedback/put` 的 request 字段未取到，只有 `list`/`delete` 已证实——**先取字段再说**，见 §5-登记）；余额显示（`account/getBalance {client, version, locale, timezoneOffsetSeconds}`，价值低）；工作流运行卡片、DSH 插件开关、打字机效果（第三批剩余项）。

---

## 1. 事实基础（实测）

1. **`session/control` 在 0.2.0 只发一帧类型**：`baseline`，且 `baseline.value` 顶层键**只有 `projections`**（1.5s 采样）。0.1.x 的 `queue` 帧在 v012 不存在 ⇒ `remote.ts` 的 queue 分支（把 `{type:"session/queue"}` 转给 manager）**永不触发**，`manager` 的 `{t:"queue"}` 因此永不发出（登记项的证实）。
2. **`inbox` 投影**：state schema ＝ `{ "next-turn": JsonValue[], "next-step": JsonValue[] }`（`dsh-agent-loop` 的 `inboxProjectionDefinition`，由 `agent/inbox/spliced` 事件重建"待注入输入"）。条目是**不透明 JSON**（`array(union([null,string,number,false,true,array,record]))`），**不是**老的 `{id, placement, text}` 结构 ⇒ 渲染必须**防御式**（见 T1 步骤 3）。
3. `inbox` 已随 `session/control` 的 `baseline`/`projection` 帧到达（投影是 record：`key → {asOfSeq, values}`），manager 已有投影转发路径（`{t:"projection", sessionId, key, value}`），只是 webview 未处理 `inbox`。
4. **`schedule/*`（0.2.0）**：方法 `schedule/catalog|delete|history|list|update`。request 内层字段：`list = {sessionId}`、`delete = {id, sessionId}`、`history = {limit, before?, id, sessionId}`。实测 `schedule/catalog {}` → PASS `[]`；`schedule/list {request:{}}` → `gateway/input-invalid`（`sessionId` 必填，形状因此确定）。
5. `messageFeedback/list = {request:{sessionId}}` → PASS `{ok:true, value:{items:[]}}`（**结果是嵌套的**）；`messageFeedback/delete = {request:{sessionId, messageId, ifVersion}}`；`messageFeedback/put` 的 request 类型名 `MessageFeedbackPutRequest`，**字段未取到**（本批不做）。
6. 现有代码：`remote.ts` 的 queue 分支与 `manager` 的 `{t:"queue"}` 通路、`protocol.ts` 的 `{t:"queue"; items:{id,placement,text}[]}`、`app.tsx` 的队列条渲染都在；本批只改**数据源**，UI 结构尽量不动。

---

## 2. 任务

### T1 待发消息条改用 `inbox` 投影（低中）

**文件**：`src/session/manager.ts`、`src/connection/remote.ts`、`webview/src/protocol.ts`、`webview/src/app.tsx`

- 步骤 1：`manager` 收到投影 `key === "inbox"` 时，把两段合成既有 `{t:"queue"}` 消息（**不新造 UI 通路**）：
  ```ts
  // inbox: { "next-turn": JsonValue[], "next-step": JsonValue[] } — the 0.2.0
  // replacement for the vanished `queue` frames (design.md §3.7 登记项).
  private postInbox(value: unknown): void {
    const v = (value ?? {}) as { "next-turn"?: unknown[]; "next-step"?: unknown[] };
    const mk = (arr: unknown[] | undefined, placement: string) =>
      (arr ?? []).map((item, i) => ({
        id: `${placement}-${i}`,
        placement,
        text: inboxText(item),
      }));
    this.host.post({ t: "queue", sessionId: this.currentSession ?? "", items: [...mk(v["next-turn"], "next-turn"), ...mk(v["next-step"], "next-step")] });
  }
  ```
  `inboxText(item)`：若 `typeof item === "string"` 直接用；若是对象且 `item.text` 是字符串用 `item.text`；若是 `{type:"text",text}` 用 `text`；否则 `JSON.stringify(item)` 截断 120 字符。
- 步骤 2：`remote.ts` 的 queue 分支**保留**（legacy flavor 仍可能发），在注释注明"v012 已无此帧，改由 inbox 投影驱动"。
- 步骤 3：webview 队列条：`placement` 的显示文案改为人话（`next-turn` → 「下一轮发送」、`next-step` → 「下一步插入」）；条目为空时不渲染（既有行为）。
- 步骤 4：**不改** 队列的编辑/插队（`updateQueue`）逻辑——它走 `session.updateQueue`，本次不动。

**验收**：真机——在 agent 忙时连发两条消息（应进队列）→ 面板**出现待发条**且两条都在；agent 消化后待发条消失；`pnpm compile` 通过。
**反例**：若连发两条时后端把它们合并/直接执行（不产生 inbox 条目），则记录实测现象并**降级**为"仅显示能解析的条目"，不得伪造条目。

### T2 定时提醒管理（中）

**文件**：`src/session/manager.ts`、`src/extension.ts`、`webview/src/protocol.ts`、`webview/src/app.tsx`、`webview/src/styles.css`

- 步骤 1：宿主：
  ```ts
  async listSchedules(): Promise<void> {
    try {
      const res = await this.lifecycle.client.call<{ items?: unknown[] }>("schedule.list", { request: { sessionId: this.currentSession } });
      this.host.post({ t: "schedules", sessionId: this.currentSession ?? "", items: (res?.items ?? []) as any });
    } catch (err) { notify warn }
  }
  async deleteSchedule(id: string): Promise<void> {
    try { await this.lifecycle.client.call("schedule.delete", { request: { id, sessionId: this.currentSession } }); await this.listSchedules(); }
    catch (err) { notify error }
  }
  ```
- 步骤 2：`extension.ts` 入站补 `case "list-schedules"` / `case "delete-schedule"`；`protocol.ts` 补入站成员与 `{t:"schedules", sessionId, items}` 出站消息。
- 步骤 3：webview 面板头部加「⏰ 提醒」入口 → Sheet：列出（标题/触发时间/来源），每行「删除」（**二次确认**）；空态「当前会话没有已登记的提醒」。字段以实跑结果为准（`schedule/list` 目前返回空数组，渲染按 `title/nextRunAt/id` 容错读取）。
- 步骤 4（可选，若字段足够）：显示提醒历史（`schedule/history {request:{limit, id, sessionId}}`）——**仅在 list 字段确认后才做**，否则不做。

**验收**：真机——让我登记一条提醒（`schedule` 工具）→ 面板列出它 → 删除 → 列表消失且服务端确认；空态正确。

---

## 3. 验证与回归

| 命令 | 期望 |
|---|---|
| `pnpm compile` / `pnpm build` | exit 0；产物 `dist/extension.cjs` + `dist/webview.js` |
| `pnpm regress:all` | fold 24/24、fence 8/8、pathlink 8/8、locate ≥25/25、model 23/23、repair 14/14（不得回退） |
| `pnpm args:audit`（桌面版 asar） | **0 处不匹配**；`schedule.list`/`schedule.delete` 需在 `client.ts` 写**显式字面量分支**才会被计入（覆盖点 40 → 42） |
| `pnpm smoke @19387` | 16/16 保持；**不新增写探针**（`schedule/delete` 是写端点，只在真机手测里用一次性数据） |
| 手测 | T1：忙时连发两条 → 待发条出现 → 消化后消失；T2：登记提醒 → 面板可见 → 删除生效 |

---

## 4. 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R1 | `inbox` 条目是不透明 JSON，可能解析不出文本 | 防御式渲染 + 截断；解析不出就显示 `(有 N 条待发消息)` 而不是空白或伪造文本 |
| R2 | 待发条与真实"排队"语义可能不完全一致（inbox 是"待注入输入"） | 文案用「待发送」而非「已排队」；design.md 记录口径差异 |
| R3 | `schedule/list` 的条目字段未见过（当前为空数组） | 容错读取 + 空态；字段不符时**只显示可读字段**，不猜 |
| R4 | `schedule/delete` 是写端点 | 只在手测里删自己登记的提醒；不写自动化写探针 |
| 回退 | 单项出问题 | 每任务一个 commit，`git revert`；无 schema/数据迁移、无系统配置改动 |

---

## 5. 文档与登记

- 文档先改：`design.md` §3.7 把"inbox 驱动待发条"从登记项改为**已实现**（并写清 `inbox` 是不透明 JSON 的口径差异）；§3.3 补 `schedule/*`；`roadmap.md` 第三批状态；`CHANGELOG.md` v0.19.4。
- **登记（本批不做）**：`messageFeedback/put` 的 request 字段未取到（类型名 `MessageFeedbackPutRequest`）——抠字段的配方：在 asar 的 `dsh-message-feedback/lib/*.js` 里搜 `MessageFeedbackPutRequest` 的 `z.object({...})`，或搜 `messageFeedback_put_parameter_0$schema`；取到后再决定是否接入点赞/点踩（现有 UI 的 👍👎 目前只写本地 state）。
- 残留：本方案探针（`%TEMP%\dsh-batch3-*.mjs`、`dsh-b3-*.mjs`）**已删除**；实施期新探针与一次性数据收尾自清理。
- 不 push；装 vsix 属系统配置变更（沿用授权，装前一句确认）。

---

## 6. 审查标准（给独立审查子代理）

**独立性**：只接收本文件；自行 read 代码 / 查 asar / 跑**只读**探针；**禁止**改文件、禁止写端点（`schedule/delete`、`messageFeedback/*` 写、`session.prompt`、`workspace/*` 写一律不得调用）、禁止建会话、禁止 push、不得派生子代理。

**必查 6 项**：
1. **事实正确性**：§1 每条是否成立？`session/control` 只有 baseline 的结论是否被你独立复现？`inbox` 的条目类型是否为不透明 JSON（决定 T1 的渲染方案）？
2. **T1 是否值得做**：`inbox` 与用户说的"排队消息"是不是同一件事？若 0.2.0 的排队语义已改（例如队列由 `session/prompt` 的 `mode:"queue"` 在服务端直接持有、不再投影），T1 是否应当**降级或取消**？请给判定。
3. **T2 的字段与最简路径**：`schedule/list` 的条目字段能否从 asar/实现侧确定（当前会话无提醒，实跑为空）？能否复用既有 Sheet/消息而不是新造通路？
4. **可测性与验收**：§3 每条能否判真假？T1 的"忙时连发两条"是否可能因 agent 太快而不稳定——给出更硬的手测/断言办法。
5. **边界与遗漏**：`inbox` 为空时是否会误清空用户正在看的队列（旧帧与新投影的竞争）；会话切换时是否会串台；`schedule` 的会话作用域（提醒是会话级还是全局——若是全局，用 `currentSession` 过滤是否错）；入站分发是否漏 `extension.ts`。
6. **红线与残留**：是否触碰写端点/系统配置/删除/push？登记项与残留声明是否属实？

**输出**：`维度 | PASS/FAIL | 证据 | 建议` + 「必须修改」/「建议修改」两张清单 + 一句话结论。