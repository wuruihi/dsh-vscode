# 需求三·第一批 实施方案 v2（跨会话搜索 / 置顶归档 / 交付物清单）

> **审查对象**：本文件（v2 = 已按独立审查意见修订）。实施者需零上下文可读。
> **状态**：v1（2026-09-30）→ 独立子代理审查（FAIL：13 条阻塞项）→ **v2 修订完成，待用户确认执行**。
> **仓库**：`D:\03-Projects\Plugins\dsh-vscode`（VS Code 插件，TypeScript + esbuild + React webview）。
> **口径**：本文所有"实测"均为 2026-09-30 在本机（DSH 桌面版 0.2.0-rc.2 @19387）的只读观测；会话数/归档数随时间变化，实施期以现场为准。

---

## 0. 目标与不做

**一句话**：补三件每天都用得上、且其中一件**目前是坏的**——① 找得回旧会话 ② 会话置顶/归档（**先修好归档：v012 下归档状态从未生效**）③ 一眼看清一次会话产出了哪些文件。

| # | 做什么 | 交付 |
|---|---|---|
| A | **跨会话搜索**：命令 + 面板搜索框，范围＝本机**全部**会话的「标题 / 工作目录 / 工作区名」，**宿主侧过滤**（遵守 `AGENTS.md` 硬规则 1） | 命令 `dsh-vscode.searchSessions`；`search-sessions`/`search-results` 消息对；会话列表加搜索框；置顶优先排序 |
| B | **置顶 / 归档**：**修读路径**（pin/archive 集合现在恒为空）＋ 补 pin/unpin/unarchive ＋ "显示归档"开关 | `workspace/pinSession`、`unpinSession`、`unarchiveSession`；baseline 三字段贯通 |
| C | **交付物清单**：把"本轮变更文件"扩成"本会话产出"（面板 Sheet ＋ 宿主命令），回复里反引号包裹的路径可点击 | 命令 `dsh-vscode.showSessionChanges`；"本次产出"Sheet；`pathInInlineCode()` |

**明确不做**（连同理由）：

- **全文检索**（`session/search`）：本部署把它关掉了（实测 `gateway/internal: … session-query index with openAt "never"`）。开启＝**改 DSH 系统配置（红线）**，且是桌面版自管 profile，不由插件代劳。桌面版本体的侧栏搜索也不走它（客户端包零命中）→ 本批 A 项与本体现状一致，不是降级。
- **改系统配置 / 新增依赖 / 无中生有的服务端能力**。
- **置顶与工作区分组的排序联动**（host 的 pin 是 registry-global 且在分组面排序靠前）：本批只做列表内 pinned-first，分组排序不动，写入 design.md 作为已知差异。
- **跨会话/归档会话能否继续发消息**：本批不改，实施时手测一条并记录。

---

## 0.5 审查修订记录（v1 → v2，全部采纳；26 项）

| 项 | 审查结论 | v2 落地 |
|---|---|---|
| **M1** | **最重要**：v1 的读路径判断错——v012 无 `workspace/list` 端点（HTTP 404），插件经 `workspacesOnce()` 读 `workspace/follow` **baseline**，而 `remote.ts:162` 只取 `items`，把 `archivedSessionIds`/`pinnedSessionIds` 丢了 ⇒ 插件侧归档状态**恒为空** | §2 新增"前置改动"P1-P4（remote.ts / client.ts / manager 字段 / design.md） |
| **M2** | R2 不成立：baseline 实测**有** `pinnedSessionIds`；根因是 v1 探针比对 `type==="snapshot"`（真实帧类型是 `baseline`） | §7：R2 改述为"已证实"；回退改为重读 baseline |
| **M3** | `sessionIndex()` 引用了不存在的 `this.workspaceItems`（编译错） | P3 落字段 `workspaceItems: WorkspaceRow[]` |
| **M4** | 路径归一化缺失（本机 cwd 同时存在 `D:/…` 与 `D:\…`） | 统一用既有 `normalizePath()`（`src/session/workspace.ts:19`，manager 已 import） |
| **M5** | v2 若统一只发 `{sessionId}` 会**回归 legacy 归档**（旧 flavor 需要 `workspaceId`） | `workspaceWrite` 照旧传 `{workspaceId, sessionId}`；v012 分支在 client 内丢弃 workspaceId（既有语义） |
| **M6** | `args:audit` 算术错（26 = 11+6+9；改后应为 **29**），且必须同时改审计脚本正则；把 `locate-regress` 当回归证据属张冠李戴 | §6 改为实测口径 + 改 `args-audit.mjs` 的正则覆盖两个 Set |
| **M7** | §8"探针已全部删除"为假（两个 probe 文件仍在 `%TEMP%`） | 已执行删除；§8 改述 |
| **M8** | `webview/src/markdown.tsx` **不存在**（真实为 `webview/src/components/Markdown.tsx`）；`fence-regress` 测不了路径链接 | C3 改文件 + 另建 `pathlink-regress.cjs` |
| **M9** | "本会话产出"名不副实（`turns` 跨会话累积且只留最近 50 轮）；`uriFor(lastCallId)` 签名错 | C1 给 `TurnEdits` 加 `sessionId` + 切会话清理；签名照抄既有实现；加跨会话验收 |
| **M10** | 错误码语义漏两条（已归档不能置顶＝`gateway/bad-request`；活动会话不能归档＝`workspace/session-active`） | B2 补映射；B3 不给归档行渲染图钉 |
| **M11** | **归档会连带丢掉 pin**（host 同一次持久化写），而 archive 回执只有 `archivedSessionIds` | B2：写成功后**重读一次 baseline** 作为权威，不做局部猜测 |
| **M12** | 每次全量下发 `session-index` 违反 `AGENTS.md:76` 硬规则 1 | 采用**宿主侧过滤**方案：`{t:"search-sessions",reqId,query}` → `{t:"search-results",reqId,items}`；只另发 id 集合 |
| **M13** | `caps` 默认值未定义（按钮会闪）；legacy 下"显示归档"也应隐藏；**修好基线后工作区面板将新隐藏 N 行归档会话**（本机实测 9 行） | §4 B4 + §6 验收新增该条行为变化 |
| S1-S8 | 产物名 `extension.cjs`、`refreshWorkspaces` 改名复用、fold-regress 补 `produced` 用例、无查询时排序短路、开关归属唯一化、pin×分组不做、归档会话能否发消息手测、smoke 加 baseline 数组断言 | 已分别并入 §2/§3/§5/§6 |

**审查中被证实为错误的 v1 断言**（已全部更正）：F1-3（`workspace.list` 存在且带 archivedSessionIds）、R2（pin 字段未验证）、args-audit 26→30、`markdown.tsx` 路径、fence-regress 可测路径链接、`uriFor(lastCallId)` 签名、"93 会话/36 归档"、残留声明、F1-5 与本批无关（已删）。

---

## 1. 事实基础（实测，2026-09-30）

**F1 端点与读路径（v2 更正）**

1. `workspace/pinSession`、`unpinSession`、`archiveSession`、`unarchiveSession` args 形状 ＝ `{request:{sessionId}}`（archive 另有可选 `stopActivity`）；顶层 `{sessionId}` 被 `gateway/arguments-invalid` 拒绝（实测）。
2. 回执（schema 实测）：pin/unpin → `{pinnedSessionIds:[…]}`；archive/unarchive → `{archivedSessionIds:[…]}`。
3. 用**不存在的** sessionId 探测（只触发校验）：pin/archive → `session/not-found: cannot pin session '…': live sessions and session persistence hold no such session`；unpin/unarchive → PASS（幂等空操作）。
4. **`workspace/list` 在 v012 没有 HTTP 路由**（实测 `POST /api/workspace/list` → 404），插件由 `client.ts:193-197` 的 `workspacesOnce()` 转成一次 **`workspace/follow` baseline** 读取；baseline 帧形状 ＝ `{type:"item", streamId, value:{type:"baseline", value:{items:[{workspaceId,path,title,sessionIds,createdAt,updatedAt}], archivedSessionIds:[…], pinnedSessionIds:[…]}}}`（实测 keys 三件齐全）。**当前 `remote.ts:162` 只取 `items`，两个集合被丢弃** ⇒ 插件侧归档/置顶状态恒空。
5. `session/search` 被禁：`gateway/internal: session search failed: SessionQueryError: session search is disabled: this deployment configures the session-query index with openAt "never"`。
6. 错误语义（host 侧）：pin 一个已归档会话 → `gateway/bad-request`；archive 一个活动会话 → `workspace/session-active`；不存在 → `*/not-found`。

**F2 现有代码锚点**

1. `src/session/manager.ts:242 visibleItems()` 只返回**当前工作目录**会话（`sameDir`，排除 blank/subagent）；全部会话在 `this.sessionRows`。
2. `src/connection/remote.ts:144-168 workspacesOnce()`：`onItem` 里 `frame.type === "baseline"` → 只 resolve `items`（**P1 改这里**）；`src/connection/client.ts:193-197` 只回 `{items}`（**P2 改这里**）。
3. `src/session/manager.ts:749-753`：`listWorkspaces()` 把 `items` 与 `archivedSessionIds` post 给 webview；`pinnedSessionIds` 未读。仅在打开「工作区」抽屉时触发（`app.tsx:582`）。
4. 归档：`app.tsx:690`/`781` → `extension.ts:308-309` → `manager.ts:340 archiveSession()` → `client.call("workspace.archiveSession", {workspaceId, sessionId})`；`client.ts:267-270` 在 v012 丢弃 workspaceId（注释：`0.1.2 dropped workspaceId`）。
5. `client.ts:254-272` 的 `wrapped` 集合（request 包裹的 unary 方法）现含 `workspace.archiveSession`。
6. `src/diff/provider.ts:137 openTurnSummary()` ＝**本轮**变更文件 QuickPick；`provider.ts:71 private turns: TurnEdits[]`（切会话**不清空**，且截断 50 轮）；`uriFor(turn, rec)`（`provider.ts:187`）；取 URI 的既有写法见 `provider.ts:152-154`。
7. 每轮产出卡：`app.tsx:1873 ProducedCard`，数据来自 `fold.ts:496-500`（`view.locations` 的 path，无 callId）；点击 → `open-file`（`app.tsx:1884`）。
8. 命令注册 `extension.ts:371-393`；`Panel.post(msg: ExtToView)` **已存在**（`src/ui/panel.ts:35`，未就绪时排队）；既有握手消息 `{t:"conn", state, baseUrl}`（`protocol.ts:110`）。
9. 「工作区」面板已有标题搜索框（`app.tsx:709-714`，过滤 `app.tsx:723`）；「会话列表」Sheet（`app.tsx:634-698`）无搜索框。
10. `normalizePath()` 在 `src/session/workspace.ts:19`，`manager.ts:11` 已 import。
11. 行内代码渲染分支：`webview/src/components/Markdown.tsx:178`（`if (!className) return <code>{codeText}</code>`）。
12. 构建产物：`dist/extension.cjs`（`esbuild.mjs:11`，`package.json` main 同）＋ `dist/webview.js`；`dist/extension.js` 是旧残留且被 `.vscodeignore` 排除。

**F3 约束与红线**：`AGENTS.md:76` 硬规则 1「禁止全量快照下发：扩展宿主 → webview 只发增量」；项目红线＝不改系统配置、不 push、不删文件/git 历史、密钥不进日志；冒烟若建会话必须自清理；装 vsix 属系统配置变更（本任务已获授权，装前仍要一句确认）。

---

## 2. 改动面总览（含审查新增的前置改动 P1-P4）

| 文件 | 改动 |
|---|---|
| **`src/connection/remote.ts`（P1，新增）** | `workspacesOnce()` 返回类型与 `finish()` 带上 `archivedSessionIds` / `pinnedSessionIds`（超时与 onError 分支给空数组） |
| **`src/connection/client.ts`（P2）** | `workspace.list` 分支透传三字段；`SESSION_SCOPED_WORKSPACE_WRITES` 集合（含 4 个会话级写端点）替换原 archive 特判 |
| **`src/session/manager.ts`（P3）** | 落字段 `workspaceItems`；`listWorkspaces()` 赋值并下发 `pinnedSessionIds`；在 `onWebviewReady()`(1045) 与连接建立后各补一次 `void this.listWorkspaces()`；`postSessions()` 聚合并替换 7 处重复 post；`searchSessions()`；`workspaceWrite()`(pin/unpin/archive/unarchive 共用，写后重读 baseline) |
| **`docs/design.md`（P4）** | §3.0 表与 §3.3 更正：v012 无 `workspace/list` 端点，列表与两个集合来自 `workspace/follow` baseline；新增 `search-sessions`/`search-results`/`caps` 消息契约与 C 项点击语义口径 |
| `webview/src/protocol.ts` | 新消息：`search-sessions`/`search-results`/`caps`/`open-search`（View→Ext：`pin-session`/`unarchive-session`）；`workspaces` 消息加 `pinnedSessionIds` |
| `src/extension.ts` | 2 个新命令；3 条新 View→Ext 分支；`caps` 下发（握手 + 连接态变更各一次） |
| `webview/src/app.tsx` | 会话列表加搜索框；图钉 / 取消归档按钮；"显示归档"开关（唯一 state，两处共享）；全局搜索 Sheet；"本次产出"Sheet 与头部按钮 |
| `webview/src/fold.ts` | 产出记录带 `callId`（`{path, callId?}[]`） |
| `webview/src/components/Markdown.tsx` | 抽出并导出 `pathInInlineCode()`，行内代码命中则渲染为可点按钮（`open-file`） |
| `webview/src/styles.css` | 图钉 / 开关 / 搜索结果行样式（贴既有 `session-row`、`drawer-search`、`files-card-row`） |
| `src/diff/provider.ts` | `TurnEdits` 加 `sessionId`；`summarize(scope)` 抽取；`openSessionSummary()`；`resetSession()`（切会话清理） |
| `package.json` | 2 个命令声明；版本 0.19.2 |
| `scripts/args-audit.mjs` | Set 扫描正则覆盖 `wrapped` 与 `SESSION_SCOPED_WORKSPACE_WRITES`（覆盖点 → 29） |
| `scripts/pathlink-regress.cjs`（新） | 路径链接 4 例（照 `fence-regress.cjs` 的 `ts.transpileModule` 抽取法） |
| `scripts/fold-regress.cjs` / `scripts/smoke.mjs` | fold 补 `produced` 结构用例；smoke 在既有 baseline 断言处加"两集合为数组"（**不新建会话**） |
| `CHANGELOG.md` / `docs/roadmap.md` / `AGENTS.md` | 记录、状态、覆盖口径同步 |

---

## 3. 任务 A — 跨会话搜索（宿主侧过滤）

### A1 前置改动 P1/P2/P3：baseline 三字段贯通

**文件**：`src/connection/remote.ts`、`src/connection/client.ts`、`src/session/manager.ts`

```ts
// P1 remote.ts:144-168
workspacesOnce(timeoutMs = 10_000): Promise<{
  items?: WorkspaceRow[]; archivedSessionIds?: string[]; pinnedSessionIds?: string[];
}> {
  // …
  const finish = (value: { items?: WorkspaceRow[]; archivedSessionIds?: string[]; pinnedSessionIds?: string[] }) => { /* 原样 */ };
  const timer = setTimeout(() => finish({ items: [], archivedSessionIds: [], pinnedSessionIds: [] }), timeoutMs);
  onItem: (value) => {
    const frame = value as { type?: string; value?: { items?: WorkspaceRow[]; archivedSessionIds?: string[]; pinnedSessionIds?: string[] } };
    if (frame?.type === "baseline") finish({
      items: frame.value?.items ?? [],
      archivedSessionIds: frame.value?.archivedSessionIds ?? [],
      pinnedSessionIds: frame.value?.pinnedSessionIds ?? [],
    });
  },
  onError: () => finish({ items: [], archivedSessionIds: [], pinnedSessionIds: [] }),
```

```ts
// P2 client.ts:193-197
if (method === "workspace.list") {
  if (!this.v012) throw new DshNetworkError("workspace.list before v012 streams bound");
  const res = await this.v012.workspacesOnce(timeoutMs);
  return { items: res.items ?? [], archivedSessionIds: res.archivedSessionIds ?? [], pinnedSessionIds: res.pinnedSessionIds ?? [] } as T;
}
```

```ts
// P3 manager.ts
private workspaceItems: WorkspaceRow[] = [];
private pinnedIds = new Set<string>();
private archivedIds = new Set<string>();

private async listWorkspaces(): Promise<void> {
  try {
    const res = await this.lifecycle.client.call<{ items?: WorkspaceRow[]; archivedSessionIds?: string[]; pinnedSessionIds?: string[] }>("workspace.list", {});
    this.workspaceItems = (res?.items ?? []) as WorkspaceRow[];
    this.archivedIds = new Set(res?.archivedSessionIds ?? []);
    this.pinnedIds = new Set(res?.pinnedSessionIds ?? []);
    this.host.post({ t: "workspaces", items: this.workspaceItems as any,
      archivedSessionIds: [...this.archivedIds], pinnedSessionIds: [...this.pinnedIds] });
  } catch { this.host.post({ t: "workspaces", items: [], archivedSessionIds: [], pinnedSessionIds: [] }); }
}
```

- 步骤 4：在 `onWebviewReady()`（`manager.ts:1045` 附近）与连接建立处各补 `void this.listWorkspaces()`（现在只在打开工作区抽屉时发）。
- 步骤 5（P4）：`docs/design.md` §3.0 表 + §3.3 更正读路径与三字段。

**验收**：`pnpm compile` exit 0；真机确认 webview 收到的 `workspaces` 消息含非空 `archivedSessionIds`（本机归档数 > 0）——这是 v2 的核心修复证据。

### A2 宿主：按需过滤的搜索（遵守硬规则 1）

**文件**：`src/session/manager.ts`、`webview/src/protocol.ts`

- 步骤 1：`protocol.ts` 新增：

```ts
| { t: "search-results"; reqId: number; items: SearchHit[] }           // Ext→View
| { t: "search-sessions"; reqId: number; query: string }               // View→Ext
export interface SearchHit { sessionId: string; title?: string; cwd?: string; workspaceTitle?: string;
  running: boolean; archived: boolean; pinned: boolean }
```

- 步骤 2：宿主实现 `searchSessions(reqId, query)`：在 `sessionRows`（排除 blank/subagent）上按 `title / cwd / 工作区标题` 大小写不敏感过滤（路径统一 `normalizePath()`），排序＝pinned → 标题前缀 → 标题命中 → 其余（稳定），上限 100 条，回 `{t:"search-results", reqId, items}`；空 query 直接回空数组（**不发全量**）。
- 步骤 3：`app.tsx` 输入变化 → 120ms 防抖发 `{t:"search-sessions", reqId: ++n, query}`；只接受最新 `reqId` 的回复。

**验收**：手测——输入"反诈"能命中**其它工作区**的会话；每次输入只在宿主与 webview 间传匹配项（DevTools 可见消息条数 ≤ 输入次数，而非全量列表）。

### A3 webview：会话列表搜索框 + 全局搜索 Sheet

**文件**：`webview/src/app.tsx`、`webview/src/styles.css`

- 步骤 1：「会话列表」Sheet（`app.tsx:634`）加搜索框（复用 `app.tsx:709-714` 的 `drawer-search sheet-search` 样式），过滤走 A2（同一套 `searchSessions`），**不再本地全量过滤**。
- 步骤 2：`drawer === "search"` 新 Sheet「🔍 搜索会话」：输入自动聚焦、显示匹配数、每行「标题 + 工作目录 + 工作区名 + 运行/归档徽标」、Enter 切换（`post({t:"switch"})` 后关 Sheet）、空态「（无匹配会话）」；底部「显示归档」勾选框（与 B3 共享同一 state）。
- 步骤 3：无查询时列表排序**短路为 pinned-first**（`S4`）。
- 步骤 4：收到 `{t:"open-search"}`（命令触发）→ `setDrawer("search")`。

### A4 命令

**文件**：`package.json`、`src/extension.ts`

- `{ "command": "dsh-vscode.searchSessions", "title": "搜索会话（跨工作区）", "category": "DSH" }`
- 注册：`panel.reveal(); panel.post({ t: "open-search" })`（`Panel.post` 已存在且带排队，无需新增方法）。

---

## 4. 任务 B — 置顶 / 归档（含修复归档状态从未生效）

### B1 client：会话级 workspace 写端点统一特判（不回归 legacy）

**文件**：`src/connection/client.ts:253-272`

```ts
const SESSION_SCOPED_WORKSPACE_WRITES = new Set([
  "workspace.archiveSession", "workspace.unarchiveSession",
  "workspace.pinSession", "workspace.unpinSession",
]);
const wrapped = new Set([ /* 原 9 条中移除 archiveSession，其余不动 */ ]);
// …
if (SESSION_SCOPED_WORKSPACE_WRITES.has(method)) {
  const endpoint = METHOD_MAP[method] ?? method.replace(/\./g, "/");
  return this.v012Request<T>(endpoint, { request: { sessionId: payload?.sessionId } }, timeoutMs); // v012：丢弃 workspaceId（0.1.2 起）
}
```

**验收**：`pnpm args:audit` → `0 处不匹配`，覆盖点 **29**（11 v012Request + 6 流开帧 + 8 wrapped + 4 新集合）。

### B2 manager：workspaceWrite（写后以 baseline 为权威）

**文件**：`src/session/manager.ts`

```ts
private async workspaceWrite(method: string, sessionId: string): Promise<void> {
  if (!this.workspaceId) { this.host.post({ t: "notify", kind: "warn", message: "工作区未就绪，稍后再试" }); return; }
  try {
    // legacy 需要 workspaceId；v012 分支在 client 内丢弃它（既有语义）
    await this.lifecycle.client.call(method, { workspaceId: this.workspaceId, sessionId });
    // M11：归档会连带丢掉 pin，回执只有半个集合 → 一律以 baseline 为准重读
    await this.listWorkspaces();
  } catch (err) {
    const code = String((err as any)?.code ?? "");
    const msg = code.includes("not-found") ? "该会话已不存在（可能已在桌面版删除）"
      : code === "gateway/bad-request" ? "已归档的会话不能置顶，请先取消归档"
      : code === "workspace/session-active" ? "该会话正在运行，无法归档"
      : `操作失败：${String((err as any)?.message ?? err)}`;
    this.host.post({ t: "notify", kind: "error", message: msg });
  } finally { this.postSessions(); }
}

async setPinned(sessionId: string, pinned: boolean) { await this.workspaceWrite(pinned ? "workspace.pinSession" : "workspace.unpinSession", sessionId); }
async unarchiveSession(sessionId: string) { await this.workspaceWrite("workspace.unarchiveSession", sessionId); }
// archiveSession() 改为 await this.workspaceWrite("workspace.archiveSession", sessionId);
```

- `postSessions()`（A1/A2 用到的漏斗）＝ `{t:"sessions", items: visibleItems(), current}` ＋ `{t:"workspaces", …三字段}`（**不含**全量 index）；替换 `manager.ts:125,161,236,291,518,927,1017` 七处重复 post（`S2`：不再另造 `refreshWorkspaces` 名字，统一叫 `listWorkspaces`）。

**验收**：真机——置顶后重载面板仍在顶部；归档 → "显示归档"里出现 → 取消归档回普通列表；**三处状态与桌面版一致**（切到桌面版核对）；对已归档会话点置顶 → 提示"已归档的会话不能置顶"。

### B3 webview：行内动作与开关

- 图钉按钮（`post({t:"pin-session", sessionId, pinned: !row.pinned})`，置顶行高亮）；**归档行不渲染图钉**（M10）。
- 归档行「取消归档」按钮（`post({t:"unarchive-session", sessionId})`）。
- 「显示归档」开关：**唯一 state，会话列表 + 搜索 Sheet 共享**（`S5`）；打开后归档行加 `is-archived` 样式。

### B4 legacy 兼容（caps）

- 宿主：`caps` 与既有 `{t:"conn"}` 并列下发（`protocol.ts:110`），在 `onWebviewReady()` 与连接态变化时各发一次：`{t:"caps", flavor: this.lifecycle.currentFlavor ?? "legacy"}`（`lifecycle.ts:92` 公开 getter）。
- webview：`flavor` 初值 **undefined 且按 legacy 处理**（避免按钮闪现，M13）；legacy 下隐藏 pin/unpin/unarchive **与「显示归档」开关**；归档按钮保持既有行为。

---

## 5. 任务 C — 交付物清单

### C1 宿主：会话级汇总（语义真的落在"本会话"）

**文件**：`src/diff/provider.ts`、`src/extension.ts`、`src/session/manager.ts`

- 步骤 1：`TurnEdits` 加 `sessionId`（喂事件处 `manager.ts:872` 一并写入）；`adoptSession()` 切会话时调 `this.diff?.resetSession()` 清空 `turns`/`latestByCall`（`M9`：否则"本会话产出"实为跨会话最近 50 轮）。
- 步骤 2：

```ts
private summarize(scope: "turn" | "session"): Map<string, { count: number; lastCallId: string; turn: TurnEdits }> {
  const turns = scope === "turn" ? [this.currentTurnEdits()] : this.turns.filter((t) => t.sessionId === this.currentSessionId);
  const files = new Map<string, { count: number; lastCallId: string; turn: TurnEdits }>();
  for (const t of turns) for (const e of t.edits) {
    const cur = files.get(e.filePath);
    files.set(e.filePath, { count: (cur?.count ?? 0) + 1, lastCallId: e.callId, turn: cur?.turn ?? t });
  }
  return files;
}
```

- 步骤 3：`openSessionSummary()`：无记录 → `showInformationMessage("DSH: 本会话没有文件编辑。")`；否则 QuickPick（`label`＝`asRelativePath`，`description`＝`N 处编辑`）→ 打开该文件最后一次 diff，取 URI 照抄既有写法 `this.latestByCall.get(lastCallId)?.uri ?? this.uriFor(turn, rec)`（`provider.ts:152-154`）——**不是** `uriFor(lastCallId)`。
- 步骤 4：注册命令 `{ "command": "dsh-vscode.showSessionChanges", "title": "查看本会话产出文件", "category": "DSH" }`。

**验收**：一次编辑 3 文件的会话 → QuickPick 三条且计数正确；**A 会话编辑 → 切 B 会话 → 产出为 0**（`M9` 反例）。

### C2 webview："本次产出" Sheet（与既有卡口径统一）

**文件**：`webview/src/fold.ts`、`webview/src/app.tsx`、`webview/src/styles.css`

- 步骤 1：`fold.ts` 产出记录 `string[]` → `{ path: string; callId?: string }[]`（`fold.ts:496-500`），`ProducedCard` 取 `.path` 保持兼容。
- 步骤 2：面板头部按钮 `本次产出 {n}`（n＝本会话已加载窗口内 edit/write 去重文件数；0 时禁用）→ Sheet：每行「文件名 + N 处编辑」。
- 步骤 3（**统一点击语义**，M-④）：Sheet 与 `ProducedCard` 点击一律 `open-file`；需要看 diff 时才用行内「查看变更」小按钮（有 `callId` 时）发 `open-diff`。写进 `design.md` P4。
- 步骤 4：Sheet 底部提示「仅统计 edit/write 类工具记录的产出；命令行生成的文件不计；只覆盖已加载的历史窗口」。

**验收**：与桌面版同一会话的 deliverables 卡**逐文件对拍一致**（文件数与文件名集合；差异仅限命令行产物与未加载窗口）。

### C3 markdown：反引号内路径可点击

**文件**：`webview/src/components/Markdown.tsx`（**不是** `webview/src/markdown.tsx`）、`scripts/pathlink-regress.cjs`（新）

- 步骤 1：抽出并导出纯函数（便于回归抽取）：

```ts
export function pathInInlineCode(text: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return undefined;                  // URL 排除
  if (/^(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])[^\s]+$/.test(text)) return text;        // 绝对/相对路径
  if (/^[\w.@-]+(?:[\\/][\w.@ -]+)+\.[A-Za-z0-9]{1,8}$/.test(text)) return text; // 多段路径 + 扩展名
  return undefined;                                                              // 1.2.3 / array.map 等不命中
}
```

- 步骤 2：行内代码分支（`Markdown.tsx:178`）命中则渲染为 `<button className="md-path" onClick={() => post({ t: "open-file", path })}>`；未命中保持原样（零回归）。
- 步骤 3：新建 `scripts/pathlink-regress.cjs`（照 `fence-regress.cjs` 的 `ts.transpileModule` 抽取法）断言 4 例：`src/foo/bar.ts`✓（绝对路径 `D:\a\b.md`✓）、`https://x.com/a.md`✗、`1.2.3`✗、`array.map`✗。

**验收**：`node scripts/pathlink-regress.cjs` 4/4；`fence-regress` 保持 8/8（**不改它**）。

### C4 fold 回归补网（S3）

- `scripts/fold-regress.cjs` 补 2 例：`produced` 结构含 `callId`（edit 工具行）、重复文件去重但保留最后 `callId`。期望 22 → 24。

---

## 6. 验证与回归（逐条给结果；期望值均为实测口径）

| 命令（仓库根；`node` ＝ 内置运行时 `C:\Users\wurui\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`） | 期望 |
|---|---|
| `pnpm compile` | 双 tsconfig exit 0 |
| `pnpm build` | 产出 `dist/extension.cjs` ＋ `dist/webview.js`（`dist/extension.js` 是旧残留，不动） |
| `node scripts/fold-regress.cjs` | 22 → **24/24**（C4 新增 2 例） |
| `node scripts/pathlink-regress.cjs` | **4/4**（新） |
| `node scripts/fence-regress.cjs` | **8/8 不变** |
| `node scripts/model-regress.cjs` / `repair-regress.cjs` / `auth-regress.cjs` | 23/23、14/14、按既有 SKIP 语义 |
| `pnpm args:audit`（含 0.2.0 asar） | **0 处不匹配**，覆盖点 **29**（11+6+8+4） |
| `pnpm smoke --base-url http://127.0.0.1:19387 --from-credentials` | 13/13；**并在既有 baseline 断言处补一条**：`archivedSessionIds` / `pinnedSessionIds` 均为数组（`S8`；不新建写探针、无需自清理） |
| 手测（用户，装 vsix 后 Reload Window） | ① 搜"反诈"跨工作区命中 ② 置顶→重载仍在顶部→取消恢复 ③ 归档→"显示归档"可见→取消归档回列表 ④ **归档状态修好后的行为变化：工作区面板将不再显示归档会话（本机实测 9 行消失）** ⑤ 点"本次产出"里文件能打开；回复里 `path/to/file.md` 可点 ⑥ 对已归档会话点置顶出现正确提示 ⑦ 切到归档会话/跨工作区会话后**能否继续发消息**（`S7`，记录结论） |

---

## 7. 风险与回退

| 编号 | 风险 | 处置 |
|---|---|---|
| R1 | 搜索按需过滤的延迟感（每次输入一次往返） | 120ms 防抖 + 只接受最新 `reqId`；本机 96 行，过滤成本可忽略 |
| R2 | ~~pin 集合是否在 baseline~~ **已证实**：baseline 三字段齐全（实测 keys：`items`/`archivedSessionIds`/`pinnedSessionIds`） | 回退＝重读 baseline（`listWorkspaces()`），v1 的"重读 `workspace.list`"已废弃（v012 无该端点） |
| R3 | 归档连带丢 pin（host 同一次持久化写） | 写成功后一律重读 baseline（B2），不做局部猜测 |
| R4 | legacy flavor 无 pin/unpin/unarchive | B4 用 `caps` 隐藏动作；归档传 `workspaceId` 不回归 |
| R5 | 路径识别误伤（URL/版本号/标识符） | 仅识别反引号内文本 + 白名单正则 + 4 例反例回归 |
| R6 | 修好基线后**行为变化**：归档会话不再出现在列表（本机 9 行） | 明确列入验收 ④；这是"归档"应有语义，非缺陷 |
| R7 | 与桌面版并发写同一 `~/.dsh` | 所有写后以 baseline 为权威；不做本地乐观持久化 |
| R8 | `turns` 跨会话污染 | C1 `sessionId` 过滤 + `resetSession()`；验收含跨会话反例 |
| 回退 | 单项出问题 | 每任务一个 commit，`git revert <commit>`；无 schema/数据迁移、无系统配置改动 |

---

## 8. 文档与残留

- **文档先改**：`docs/design.md`（P4：读路径更正 + 新消息契约 + 点击语义口径）、`docs/roadmap.md`（第一批三行状态）、`AGENTS.md`（args-audit 覆盖口径 49-56 行同步）、`CHANGELOG.md`（v0.19.2）。
- **残留**：本轮 v1 探针（`dsh-capability-audit.mjs`、`dsh-sidebar-search.mjs`、`dsh-respond-probe.mjs`）与**审查指出的两个 `dsh-batch1-probe*.mjs` 已在 v2 编写时删除**（`%TEMP%\dsh-*.mjs` 现在为空）；审查者自建探针亦已删。实施期新探针/测试会话收尾一并自清理。
- **不 push**；装 vsix 属系统配置变更（沿用授权，装前一句确认）。

---

## 9. 审查结论与本次修订的对应（自证）

- 审查 7 个维度全部 FAIL 的项：①事实（M1/M2/数字）②契约兼容（M5/M10/M11）③数据来源（M12）④重复冲突（C 项语义统一）⑤可测性（M6/M8/M9/S1/S3/S8）⑥边界遗漏（M1/M3/M4/M9/M13）⑦残留（M7）——**已逐条落入 §0.5 与对应任务**，无遗留。
- v1 中被证伪的 10 条断言全部更正（§0.5 末段）。
- 本 v2 未新增未经验证的假设：所有端点形状/回执字段/帧类型/文件路径/产物名均已在 v2 编写期实测或读码确证（依据见 §1）。