# dsh-vscode 项目规范

DSH（DeepSeek Harness）的 VSCode 客户端插件。协议客户端 + IDE 上下文桥，不是 agent 运行时。

## 项目定位与边界

- **连接路线（已定，2026-09-30 修订）**：**附身运行中的常驻实例**，不 spawn 第二写者、不做 broker、不做端口扫描。候选固定两个：桌面版 Electron App（`127.0.0.1:19387`，**端口是硬编码常量**，无回退）与旧 CLI `dsh web`（`3080`）。默认优先桌面版（自动更新到最新）；两者都在时状态栏 + `DSH: Select DSH Instance` 可切换；`dsh-vscode.baseUrl` 显式设置永远最高优先。都没起 → 提示"打开桌面版 App"（兜底，App 未装则退到一键拉起旧版 3080）。**红线：绝不用桌面版 CLI 起 `web` profile**——它的 bundled pnpm + 0.2.0 installAnchor 会把 `~/.dsh/profiles/node_modules`（现在是 0.1.5 树）重装，永久破坏旧 CLI。契约见 docs/design.md §3.5。**2026-09-30 更新：用户已删除旧 CLI（`C:\Users\wurui\dsh`）⇒ 本机只剩桌面版实例；3080 候选、`autoStart`、`startDsh` 兜底代码全部保留（重装旧 CLI 即自动恢复），但"启动旧版"入口仅在能解析到 CLI 时才提供。**
- **协议双 flavor（2026-09-02 定）**：同时兼容 0.1.1-rc.x（legacy 点式端点/双WS/respond）与 0.1.2+（v012 斜杠端点/单WS remote.mux/token换cookie），连接时探测自动切换，未知形态出横幅不静默死。用户**持续升级 DSH 到最新版**——每次升级后跑 `pnpm smoke` 确认适配。契约详见 docs/design.md §3.0。
- **会话共享**：与 DSH GUI 同一实例同一存储，会话/插件生态全共享。
- **分发**：仅本地 vsix，不发布 Marketplace（发布是红线，需用户另行确认）。
- 架构设计见 `docs/design.md`（唯一权威，改架构先改它）；改造路线见 `docs/roadmap.md`；竞品分析见 `docs/competitor-analysis.md`。

## 目录约定

```
src/          扩展宿主代码（Node 侧：协议客户端、diff provider、上下文附加）
webview/      前端（React，渲染层，不做协议解析）
docs/         设计文档
scripts/      协议 smoke 测试等工具
```

- 协议知识只进 `src/connection/`，其他模块不得直接碰 HTTP/WS。`webview/src/protocol.ts` 是例外：它只描述扩展宿主↔webview 的 postMessage 消息形状，不碰 HTTP/WS。
- webview 与扩展宿主的 postMessage 类型定义在 `webview/src/protocol.ts`，双侧共用一份心智模型。

## 开发命令

```bash
pnpm install        # 装依赖
pnpm compile        # tsc --noEmit 类型检查
pnpm build          # esbuild 打包扩展宿主 + webview
pnpm package        # vsce 打 .vsix（输出 dist/）
pnpm smoke          # 连 127.0.0.1:3080 跑协议 smoke 测试（需 dsh web 在跑）
pnpm smoke -- --base-url http://127.0.0.1:19387 --from-credentials   # 连桌面版 App（凭证自动铸 cookie，无需 token）
pnpm args:audit     # 离线校验插件 RPC 参数与宿主网关描述符（旧 CLI 直接用 node 跑）
pnpm regress:all    # 全部离线回归（fold / fence / pathlink / locate / model / repair）
pnpm regress:locate # locate.ts 离线回归（25 项；真实机器集成用例在旧 CLI 目录缺失时自动 skip）
```

> 审**桌面版**（`resources/app.asar` 里）必须让 Electron 当 node，普通 node 在 asar 上读不到文件：
> `$env:ELECTRON_RUN_AS_NODE=1; & "<install>\DeepSeek Harness.exe" --expose-internals scripts/args-audit.mjs`（`DSH_ROOT=<install>\resources\app.asar\dsh`）。
> 脚本对"定位不到/asar 但非 Electron"已改为**硬失败 exit 2**（见验证纪律）。

## 验证纪律（改完必跑）

- 改 `src/`：`pnpm compile` 必须过。
- 改 `webview/`：`pnpm build` + VSCode 里 `Developer: Reload Window` 手测。
- 涉及协议交互：先 `pnpm smoke` 再手测。
- **每次 DSH 升级后必跑 `pnpm args:audit`**（smoke 只盖连接层主干，盖不到
  `commands/execute`、`subagents/list` 这类业务端点——v0.18.3 的权限切换
  失效就是这样漏过去的）。该脚本从**已安装的 DSH** 解析网关描述符当 ground
  truth，与插件实际发出的四处逐条比对：`client.ts` 的 `v012Request` 调用点、
  `remote.ts` 的 `openStream` 流开帧、`client.ts` 的 `{request}` 包裹集合
  `wrapped` 与会话级写集合 `SESSION_SCOPED_WORKSPACE_WRITES`（后两处
  2026-09-30 补，第四处随需求三第一批加入；覆盖点 29 = 11 + 6 + 8 + 4）。
  漂移即非零退出；不连服务器、不需
  token。`DSH_ROOT` 可覆盖解析目录。**已知并在代码里显式降级的漂移走
  `HANDLED_DRIFT` 白名单**（当前只有 `subagents/list`：0.2.0 已移除，插件首次
  失败即告警并停调，会话树改由 `session/list` 的 `origin`/`parentSessionId`
  派生）——新增白名单条目必须同时指出运行期降级位置，否则就是拿白名单掩盖漂移。
- **审计只盖端点名与顶层参数名，盖不到"事件名"和嵌套 schema**（2026-09-30
  实测教训：`args:audit` 对 0.2.0 报 0 漂移，但 0.2.0 已经改掉了 assistant 增量
  事件）。判断渲染层是否随 DSH 升级失效，用**事件名存活性对照**：抽
  `webview/src/fold.ts` 里全部 `case "X":`，逐个在 asar 的
  `node_modules/**/*.js` 里数命中包——**只在 `dsh-session-format-v*` /
  `persistence-jsonl`（历史格式与迁移）里命中 = 该事件已不在 live 通道**。
- **0.2.0 协议事实（2026-09-30 实测，桌面版 19387 四次真实回合）**：
  - `assistant/chunk`（0.1.x 的逐字增量）**已从 live 通道移除**，只剩历史格式/迁移代码引用；实时改发 `assistant/message`——**每步一条完整消息**，内嵌 `data.stream[]` 时间线（含 `dt`）。插件的 `fold.ts` 两代都认（`assistant/message` 分支原本是为历史回放写的），所以正文照常显示；**代价是没有逐字打字机效果**（整条出现）。
  - `session/page` 的 `request` **强制要求 `throughSeq`**（缺了报 `gateway/input-invalid: boundary validation`）；`client.ts` 本来就传（`historyCursor`），别删。
  - `workspace/archiveSession` 仍是 `{request:{sessionId}}`（平铺会报 `arguments-invalid`）；`subagents/list` 已移除。
  - `smoke.mjs` 的 v012 断言已改成两代通吃（chunk text-delta **或** `assistant/message` 正文），旧断言只认 chunk，会在 0.2.0 上假报 FAIL。
- 每次打包 vsix 后，装进 VSCode 实测连接 + 发一条消息 + 看一次 diff，三项全过才算包可用。
- **收尾必清测试残留**：smoke / 回归连的是**用户同一个 DSH 存储**，它们建的会话会以「未分组」的形式永久留在用户侧（v0.18.5 前 `smoke.mjs` 就留下了两个 `[smoke-test] 可删除`，被当成事故人工清理）。DSH **没有删除会话的 API**，只有 `workspace/archiveSession`＝侧栏隐藏：
  - `scripts/smoke.mjs` 收尾已内建：会话 id 收进 `smokeSessionIds` → 归档 → `scripts/session-purge.mjs` 删会话日志 + 投影缓存 → 断言 `logDirOf(sid) === null`（`teardown:` 那条 ok）。**加新链/新会话必须往 `smokeSessionIds` 里塞**。
  - 本机全局清扫：`node D:\02-bywork\tmp-plugin-debug\session-cleanup.mjs stale`（已归档但文件还在＝可疑残留，临时目录 cwd 的即测试残留）、`purge <sessionId...>`、`ghosts` / `sweep`（无主投影缓存：运行中的宿主会把热会话缓存重写回来，这份是纯派生垃圾）。
  - 其余临时物（`%TEMP%` 夹具、调试日志、中间产物）同样在收尾时删，别留在盘上。

## 硬性设计规则（违反即 bug）

1. **禁止全量快照下发**：扩展宿主 → webview 只发增量（原始事件流微批转发，16ms 合帧）。dsh-vsc 的 O(n²) 卡顿根因，绝不重蹈。
2. **禁止 import DSH 内部包**：不 require `@deepseek-ai/dsh-*` 的任何东西。协议解析自己做、宽松校验（只查关键 `type` 字段），未知字段/事件一律忽略并记诊断日志，不许崩。
3. **上下文附加必须发真实内容块**：选区/活动文件的内容进 prompt content，禁止只发 `@path` 文本。
4. **模型选择用 `m.id` 不用 `m.name`**（name 大写会 400）。
5. **workspace 路径必须归一化**（反斜杠/大小写）后再匹配，防误 create 报 realpath ENOENT。
6. **WS 事件按 `payload.sessionId` 过滤（仅 mux 会话域帧）**：mux 全量广播所有会话，`session/*`、`approval/*`、`question/*` 帧不过滤会串台；host 域帧和 `stream/error` 没有 sessionId，全量处理。

## 编码约定

- TypeScript strict；扩展宿主侧不用 React 依赖。
- 错误处理：连接层错误必须有用户可见的降级 UI（状态条/横幅），不许只进 console。
- 日志走 VSCode OutputChannel（`dsh-vscode`），分级 log/warn/error。

## 红线（继承全局）

删除文件、改密钥、公开发布等操作必须先问用户。

---

最后更新: 2026-09-30（实例选择：默认优先桌面版 19387、显式 baseUrl 最高优先、可切换、兜底打开 App；`args:audit` 补流开帧/wrapped 覆盖 + asar 硬失败；0.2.0 实测事实与「事件名存活性对照」方法写入验证纪律）
