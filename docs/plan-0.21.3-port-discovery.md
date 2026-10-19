# 方案：桌面版动态端口发现（DSH 0.2.1 适配）

> 状态：**已实施（v0.21.4）**。本文件保留提案原文作审查留痕；**实现与最终口径以 `docs/design.md` §3.5 + 代码为准**。实施后的偏差：发现改「tasklist+netstat 快路径（约 0.17s）+ PowerShell 兜底（上限 3s）」；看门狗 5s→30s 指数退避（不是 3s 固定）；注入缝为 `launch/home/timeoutMs/intervalMs`（无 `now`）；新增 `SessionManager.restoreSession`、`scripts/which-port.cjs`、`scripts/instances-regress.cjs`（20 项，`--live` 显式开关）。
> 背景：DSH 桌面版 0.2.1-rc.2 起把本地网关端口从固定 `19387` 改为系统分配（`dsh-desktop-host/lib/index.js` 传 `--no-open --host 127.0.0.1 --port 0`；官方 release note v0.2.1-alpha.1「桌面版默认使用系统分配的端口，避免 Windows 保留端口范围导致应用无法启动」）。插件 0.21.2 的 `instances.ts` 仍只探 `19387` / `3080`，日志 `[instances] no instance answered`，面板连不上。

## 1. 目标

让插件在桌面版端口每次启动都变的情况下仍能自动连上；不要求用户手填端口，不引入第二个写者，不改变既有逃生舱语义。

## 2. 设计决策

1. **运行时发现端口，而不是猜**：枚举「桌面版进程（`DeepSeek Harness.exe`）持有的 TCP 监听端口」，逐个用现有 `detectFlavor` 探活（401 也算活）。Windows 上实测 `Get-Process` + `Get-NetTCPConnection` 一次约 0.9s。
2. **候选顺序**：发现的桌面版端口（多个则按端口升序）→ 旧固定端口 `19387`（兼容 0.2.0 及以前）→ 旧 CLI `3080`。发现的端口全部加进 `candidates`，`probe` 首个活者胜出。
3. **显式 `dsh-vscode.baseUrl` 仍然最高优先**：pinned 时不跑发现、不探测其他候选（逃生舱行为不变）。
4. **发现失败必须降级不阻塞**：PowerShell 不可用/超时/非 Windows → 返回空数组，退回固定候选表；异常只 warn 不抛。
5. **「打开桌面版」后等发现的端口**：启动 App 后轮询「发现 → 探活」，命中即 `wireInstance` 重建 generation（`DshLifecycle`/`RpcClient`/`Auth` 的 baseUrl 构造即固定，必须换对象，不改既有约束）。
6. **断线期间自动重新解析**：当前 generation 处于 `disconnected` 时，每 3s 做一次 `resolveInstance`；发现不同地址就重建。桌面版重启换端口后无需用户操作。pinned 模式不启用。
7. **不做的事**：不扫全部本地端口（只认桌面版进程持有的监听端口）；不 spawn 第二个 DSH；不改协议层；不缓存端口到磁盘（端口每次启动都变，缓存只会过期）。

## 3. 改动清单

### 3.1 `src/connection/instances.ts`
- 保留 `DESKTOP_APP_PORT = 19387`（注释改为「0.2.0 及以前的固定端口；0.2.1 起仅作兼容候选」）与 `LOCAL_WEB_PORT = 3080`。
- 新增 `discoverDesktopPorts(timeoutMs = 4000): Promise<number[]>`：
  - 仅 `win32`；PowerShell `-NoProfile -NonInteractive -Command`（复用 `execFile("powershell", ...)` 风格，`windowsHide`）。
  - 命令：取 `Get-Process -Name 'DeepSeek Harness'` 的 Id 集合 → `Get-NetTCPConnection -State Listen` 过滤 `OwningProcess ∈ ids` → 输出端口列表（逗号分隔）。
  - 解析只取 `/\d+/g`，过滤 `1..65535`、去重排序、上限 8 个；任何失败返回 `[]` 并 `warn`。
- `candidateInstances(appPath?, discoveredPorts: number[] = [])`：桌面版候选按上面的顺序展开（`id` 用 `desktop-app:<port>`，`profile: "desktop"`），再加旧 CLI 候选。旧固定 19387 只在未被发现列表包含时追加。
- `InstanceResolveOptions` 增加注入缝 `discoverPorts?: () => Promise<number[]>`（离线回归用）。
- `resolveInstance`：pinned 分支不动；非 pinned 分支先 `await (opts.discoverPorts ?? discoverDesktopPorts)()`，再按候选顺序 probe。日志区分「发现的端口」与「固定候选」。
- 新增 `waitForDesktopInstance(appPath, opts)`：`openDesktopApp(appPath)` 之后循环 `discoverPorts → probe`（默认每 1200ms，超时 60s），返回首个活性 `DshInstance`；注入缝 `probe` / `discoverPorts` / `now` 便于离线回归。
- `profileOfBaseUrl` 不改（动态端口无法从端口反推 profile；发现的候选自带 `profile: "desktop"`）。

### 3.2 `src/connection/lifecycle.ts`
- 删除 `launchDesktopApp()`（其职责移到 `waitForDesktopInstance` + `extension.ts` 的 `wireInstance`；保留 `probe` / `startDsh` / `keepDetecting` 不动）。
- 移除因此不再使用的 `openDesktopApp` import。

### 3.3 `src/extension.ts`
- `offerInstance()` 的「打开桌面版」分支改为：`waitForDesktopInstance(appPath)` → 命中 `wireInstance(inst)`；未命中给出可见错误（`showErrorMessage`）并进入重试循环（不静默）。
- 新增断线看门狗：`onState("disconnected")` 时启动 `setInterval(3000)`；`connected` 时清除。回调里若 `pinned` 或已 connected 则跳过；否则 `resolveInstance`，`instance && instance.baseUrl !== baseUrl` 才 `wireInstance`。加 in-flight 标志防重入。
- `offerInstance` 文案去掉「桌面版 19387」硬编码端口；`pickInstance` 的「自动选择」描述改为「优先桌面版（运行时发现端口），其次旧版 3080」。
- `pickInstance` 里选中「发现的桌面版实例」时**写回 `undefined`**（回到自动模式），避免把一次性端口钉进设置；选中旧 CLI / 自定义地址仍写入 `baseUrl`。
- 状态条 tooltip 保持不变（`describeInstance` 已含实际地址与 profile）。

### 3.4 `package.json`
- `version` → `0.21.3`。
- `dsh-vscode.baseUrl` 描述更新：自动探测「运行中的桌面版（端口运行时发现）」→ 旧 CLI 3080；显式值仍是逃生舱。
- scripts 增加 `"regress:instances": "node scripts/instances-regress.cjs"`，并加入 `regress:all`。

### 3.5 `scripts/instances-regress.cjs`（新增，纯离线）
用 esbuild 把 `instances.ts` 打成临时 cjs，注入 `probe` / `discoverPorts` 缝，断言：
1. 发现端口 `[59204]` 时，首个候选是 `http://127.0.0.1:59204`，`kind=desktop-app`、`profile=desktop`，且能被选为实例。
2. 无发现结果时，候选顺序为 `19387 → 3080`（兼容旧版）。
3. 发现多个端口时按升序展开，全部进 `candidates`；首个活的胜出（模拟 59204 死、59211 活）。
4. pinned `http://127.0.0.1:8080`：不调用 `discoverPorts`，只 probe 该地址。
5. `discoverPorts` 抛错/返回空：不抛出，回退固定候选表。
6. `waitForDesktopInstance`：第一次发现空、第二次发现 `[59204]` 且探活成功 → 返回 59204；超时 → `undefined`。
7. `readPermissionPreset` 用临时 `home` 夹具读出 `danger-full-access`。
运行结束删临时 bundle。另加一条**真实机器集成用例**：仅当 `discoverDesktopPorts()` 真的返回端口时，`resolveInstance({home})` 必须选中其中一个（本机现在应是 59204），否则自动 skip（保持离线可跑）。

### 3.6 文档
- `docs/design.md`：§1 非目标行、§2 架构图/决策表、§3.5 整节改为「运行时端口发现」版本（候选顺序、发现机制、pinned 优先、端口变化处理）、§4 V1 激活流程行。
- `AGENTS.md`：连接路线第 1 条改为「桌面版端口运行时发现（0.2.1+ 系统分配；19387 仅兼容旧版）」并删掉「不做端口扫描」的旧表述；补一条验证纪律：改连接层后跑 `pnpm regress:instances` + 真实机器 `resolveInstance` 验证；更新「最后更新」行。
- `CHANGELOG.md`：0.21.3 条目。

## 4. 验证

1. `pnpm compile` 0 错（硬门槛）。
2. `pnpm regress:all` 全过（含新增 `regress:instances`）。
3. 真实机器：临时脚本 bundle `instances.ts` → `resolveInstance({home})`，断言选中的 baseUrl 命中当前 `59204`（本机桌面版在跑）。
4. `pnpm smoke -- --base-url http://127.0.0.1:59204 --from-credentials`（连接层主干 + 清理断言）。
5. `pnpm package` → 装 vsix（升版本号，0.21.3）→ 用户 `Developer: Reload Window` → 状态条 connected、面板可列会话、发一条消息、看一次 diff。
6. 桌面版重启后（端口变）状态条自行恢复 connected（用户配合或次日验证）。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| PowerShell 慢/被策略禁 | 4s 超时；失败返回空数组，行为退回今天（固定候选），不新增阻塞 |
| 进程名更名/多版本共存 | 只认 `DeepSeek Harness.exe` 的监听端口；多个都探活，活者胜出；不认识就退回固定候选 |
| 端口被别的程序占用误判 | 只取桌面版进程 own 的监听端口，不是全端口扫描；探活还要过 `detectFlavor` |
| 发现结果与旧 CLI 3080 混淆 | 3080 始终作为独立候选；发现候选标注 `desktop` profile |
| 断线看门狗频繁唤醒 | 3s 间隔 + in-flight 标志 + connected 即清定时器；pinned 不启用 |
| 用户把动态端口钉进 baseUrl | 选中发现的桌面版实例时写回 `undefined`（自动模式），并在日志说明 |
| 误起第二个写者 | 本方案不启动任何服务；「打开桌面版」仍是唯一拉起路径，且只拉起桌面版 |

## 6. 回滚

`git checkout -- .` 回到 0.21.2，重装 `dsh-web-vscode-0.21.2.vsix`（仓内已有），或装 0.21.2 的已安装副本。文档改动一并回滚。

## 7. 验收判据（人可核对）

- 插件日志出现 `[instances] selected 桌面版 DSH（DeepSeek Harness App） (http://127.0.0.1:59204, profile desktop)`。
- 关掉桌面版再打开（端口变化）后，30s 内状态条恢复 connected。
- pinned 场景（手动设 8080）行为与今天完全一致：只探 8080。
