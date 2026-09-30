# 需求三·第三批 实施方案 v2（待发消息条修复 / 定时提醒管理 / [+待确认] UI 排版优化）

> **状态**：v1 → 独立审查（10 条阻塞项 + 9 条建议 + 5 条被证伪断言）→ **v2 修订完成**，待用户确认执行。
> **审查最重要结论**：T1 方向正确（`inbox` **就是** 0.2.0 用户看到的排队消息，应做），但 v1 有 10 处硬错；另有**第二批回归**被同时发现（已在本轮修掉，见 §0）。
> **口径**：实测环境 = 本机 DSH 桌面版 0.2.0-rc.2 @19387。

---

## 0. 本轮已顺手修掉的第二批回归（已提交 `8090af9`）

`manager.listSubagents` 调 `client.call("session.projections", { request: { sessionId } })`，而 `client.ts` 的显式分支读 `payload?.sessionId` 并**自己包一层 `{request}`** ⇒ 实发 `{"request":{}}` → `gateway/input-invalid` → 被 `.catch(() => undefined)` 吞掉 ⇒ **子代理 catalog 恒空、`mode` 恒 `"unknown"`、label 只能退化用行 title**。修法：manager 只传内层字段 `{ sessionId }`；已加注释钉住这条"manager 传内层、client 包裹"契约。

---

## 1. 修订要点（v1 → v2，逐条对应审查）

| 审查项 | v1 的问题 | v2 定稿 |
|---|---|---|
| **M1** | inbox 条目 id 用合成的 `next-turn-0` ⇒ 服务端按真实 `message.id` 定位，移除/编辑/插队三按钮全会 `session/queue-item-not-found` | 用真实 `item.id`（缺失才回退合成 id） |
| **M2** | 文本提取未读 `content[]` ⇒ 会显示原始 JSON | `content.filter(c=>c.type==="text").map(c=>c.text).join("")` → 退 `text` → 退字符串 → 最后才 `JSON.stringify` 截断 |
| **M3** | 把 `placement` 当显示文案（错） | `placement` 是**图标/插队按钮开关**：`next-turn` → `"next-turn"`，`next-step` → **`"steering"`**（既有词表，造新词会让已引导条目显示错按钮 → `session/steer-unavailable`） |
| **M4** | 切会话不重填、无守卫 ⇒ 漏显示 + 跨会话串台**双向错** | webview 在既有 `case "projection"` 里处理 `key === "inbox"`（**零 host 改动**，且该分支已有 sessionId 守卫）；`case "queue"` 补 `if (m.sessionId !== current) break;` 与"切到无待发会话立刻清空" |
| **M5** | `schedule/list` 当 `{items}` 读 ⇒ 恒空 | 实测**裸数组**（仅 active、按 `sessionId` 过滤）⇒ `Array.isArray(rows) ? rows : []` |
| **M6** | 字段 `nextRunAt` **不存在**；"来源"列不存在 | 字段 = `id/kind/title/prompt/scheduledAt`(+kind 专属)；列 = 标题 + `scheduledAt`（本地时间）+ kind 人话（"N 分钟后 / 每天 HH:mm / 每周…"）；删"来源"列 |
| **M7** | T2 文件清单漏 `client.ts`，且包裹契约与 client 冲突 | manager 只传内层字段；`client.ts` 新增**显式字面量分支**（`schedule.list` / `schedule.delete`）→ `args:audit` 覆盖点 40 → **42** |
| **M8** | 删除不校验回执 | `schedule/delete` 回执 `{id, deleted:true|false}`，非 `true` 时告警（可能已随归档会话被 `stopSessionTasks` 清掉） |
| **M9** | 文档清单漏三处 | `design.md §4 F8`（"队列项可见可删"将过期）、roadmap 第三批编号口径、roadmap 里过期的 `remote.ts:355` → **`remote.ts:405`** |
| **M10** | "不透明 JSON ⇒ 只能截断"的推论**有害** | 改写：**类型不透明、结构确定**（`UserMessage{id, content[]}`），必须用真实 id + `content` 取文本；只在本条结构意外时才退化 |
| 附带 | 第二批回归 | 见 §0（已修） |

**建议项一并采纳**：S1（走既有 projection 分支的最简路径）｜S2（文案统一「排队中（下一轮）／引导（下一步）」，与输入框的"排队/引导"一致）｜S3（写清作用域：**仅当前会话 + 仅 active**；全局视图只能用只读的 `schedule/catalog`）｜S4（归档会 `stopSessionTasks` **静默删掉该会话提醒**，空态与文档都要提示）｜S5（竞争规则显式化：**一旦收到过 inbox 投影，忽略 queue 帧**）｜S6（smoke 数字标注"以实跑为准"）｜S7（更硬验收：长任务窗口 + 只读轮询 `session/projections` 的 `inbox` 长度 2→0 + 断言芯片 id === inbox `message.id`）｜S8（"第三处同类静默失效"更正为**第四处**）｜S9（提醒面板加"刷新"：`schedule/changed` 是宿主本地事件，远程订阅不到）。

**被证伪的 v1 断言（已更正）**：`messageFeedback/put` 字段**可查**（`{sessionId,messageId,rating:"positive"|"negative",note?,category?,ifVersion}`——延后仍可，但"取不到"的理由不成立）；`schedule/list` 字段**完全确定**；`inbox` 结构确定；`placement` 不进文案；"1.5s 采样"改为"命令 + 观测窗口"。

---

## 2. 定稿任务

### T1 待发消息条（`inbox` 投影驱动）—— 低中

**文件**：`webview/src/app.tsx`（主）、`src/session/manager.ts`（首帧种一次）、`webview/src/protocol.ts`（如需）

1. webview `case "projection"` 内新增：`key === "inbox"` 时把 `{ "next-turn": [], "next-step": [] }` 转成既有队列消息（用真实 id + content 文本 + 正确 placement），**复用现有 UI**。
2. `case "queue"` 补 sessionId 守卫；会话切换（`{t:"sessions", current}` 变化）时若 inbox 无条目则清空。
3. host 在 `loadHistory` 的投影种子处补一次 inbox（保证刚打开面板/切换会话立刻可见）。
4. 竞争规则：收到过 inbox 投影后，`queue` 帧不再覆盖（legacy 服务器兼容）。
5. 文案：「排队中（下一轮）／引导（下一步）」。

**验收（可判真假）**：① 让 agent 跑一条 ≥60s 的命令，期间连发两条 → 只读轮询 `session/projections` 断言 `values.inbox["next-turn"].length === 2`，面板出现两条且**芯片 id 与 inbox `message.id` 一致**；② `turn/end` 后长度回 0、面板清空；③ 切到另一个有待发消息的会话立刻可见、切到无待发的立刻清空。

### T2 定时提醒管理 —— 中

**文件**：`src/session/manager.ts`、`src/connection/client.ts`、`src/extension.ts`、`webview/src/protocol.ts`、`webview/src/app.tsx`、`webview/src/styles.css`

1. `client.ts` 显式分支：`schedule.list` → `{ request: { sessionId } }`；`schedule.delete` → `{ request: { id, sessionId } }`。
2. manager：`listSchedules()` 读**裸数组**；`deleteSchedule(id)` 校验 `deleted === true`；`schedule/catalog`（只读、全局）用于"其它会话的提醒"视图。
3. 入站分发补 `extension.ts` 的 `case`；出站 `{t:"schedules", sessionId, items}`。
4. UI：头部「⏰ 提醒」Sheet = 标题 + 本地时间 + kind 人话 + 「删除」（二次确认）+「刷新」；空态说明"仅当前会话的 active 提醒；归档会话的提醒会被自动清除"。
5. 文档：`design.md` 新增 §3.8（`inbox` 待发条 / `schedule/*` 作用域与回执语义）；同步 §3.7 登记项、§4 F8、§3.3。

**验收**：登记一条提醒 → 面板可见（标题/时间正确）→ 删除 → 服务端 `deleted:true` 且列表消失；空态正确；`args:audit` 42 点 0 不匹配。

### T3 UI 排版优化（**待用户确认方向后执行**）

按已提交的诊断（本体字阶 12/13/14 + 11px 为主、行高成对 12→18/13→20/14→22、`chat-flow-gap=12px`；插件现状元信息大量 10–10.5px、行高混用 1/1.35/1.5/1.7、元信息还叠 opacity），执行**方向 B**：字阶收敛为 14 正文 / 13 次级 / 12 说明 / 11.5 元信息；行高按字号成对；正文行高 1.7→1.57；元信息去掉 opacity 叠加；间距节奏统一（块 12 / 行内 6 / 卡片内边距 8–10）；圆角收敛 3 档（4/8/999）。**颜色一律继续用 VSCode 主题变量**（不搬本体配色）。
**验证**：`pnpm build` + 你 Reload Window 目视对比（UI 只有眼睛能判，不派审查子代理）；`regress:all` 不得回退。

---

## 3. 验证与回归

| 命令 | 期望 |
|---|---|
| `pnpm compile` / `pnpm build` | exit 0 |
| `pnpm regress:all` | fold 24/24、fence 8/8、pathlink 8/8、locate 26 处 ok（含环境 skip）、model 23/23、repair 14/14 |
| `pnpm args:audit` | 0 处不匹配，覆盖点 40 → **42** |
| `pnpm smoke @19387` | **以实跑为准**（v012 路径历史上为 16/16）；不新增写探针 |
| 手测 | T1 三条（含 id 判等）；T2 登记/删除/刷新；T3 目视对比 |

---

## 4. 风险

| 编号 | 风险 | 处置 |
|---|---|---|
| R1 | inbox 条目结构若与 `UserMessage` 不符（类型层不透明） | 用真实 `id`；文本按 `content[]`→`text`→字符串→截断**逐级退化**；退化时芯片显示条数而非原始 JSON |
| R2 | 新老队列源竞争（legacy 服务器可能仍发 queue 帧；本机旧 CLI 已删，无法实测） | 显式规则：**收到过 inbox 投影后忽略 queue 帧** |
| R3 | `schedule` 是会话级、仅 active；归档会话的提醒会被静默清除 | UI 与文档写明；删除非 `true` 时告警 |
| R4 | T1 验收依赖"长任务窗口" | 用只读断言（轮询 inbox 长度 + id 判等）代替肉眼 |
| 回退 | 单项出问题 | 每任务一个 commit，`git revert`；无 schema/数据迁移、无系统配置改动 |

---

## 5. 文档与残留

- 文档先改：`design.md` §3.8 新增 + §3.7/§4 F8/§3.3 同步；`roadmap.md` 第三批状态（编号口径与"登记"行更正，`remote.ts:355`→405）；`CHANGELOG.md` v0.19.4。
- 登记（本批不做）：`messageFeedback/*` 接入（字段已可查：`rating/note/category/ifVersion`）、余额、工作流卡片、插件开关、打字机。**登记时不再写"字段取不到"这种不成立的理由**。
- 残留：本轮探针（`%TEMP%\dsh-batch3-*.mjs`、`dsh-b3-*.mjs`）**已删除**；实施期新探针与一次性提醒数据收尾自清理。
- 不 push；装 vsix 属系统配置变更（沿用授权，装前一句确认）。