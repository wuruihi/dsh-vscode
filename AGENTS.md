# dsh-vscode 项目规范

DSH（DeepSeek Harness）的 VSCode 客户端插件。协议客户端 + IDE 上下文桥，不是 agent 运行时。

## 项目定位与边界

- **连接路线（已定）**：直连常驻 `dsh web`（127.0.0.1:3080），不 spawn 独立实例，不做 broker。没起则提示 + 一键拉起（Start-Process 脱离方式）。
- **会话共享**：与 DSH GUI 同一实例同一存储，会话/插件生态全共享。
- **分发**：仅本地 vsix，不发布 Marketplace（发布是红线，需用户另行确认）。
- 架构设计见 `docs/design.md`（唯一权威，改架构先改它）。

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
```

## 验证纪律（改完必跑）

- 改 `src/`：`pnpm compile` 必须过。
- 改 `webview/`：`pnpm build` + VSCode 里 `Developer: Reload Window` 手测。
- 涉及协议交互：先 `pnpm smoke` 再手测。
- 每次打包 vsix 后，装进 VSCode 实测连接 + 发一条消息 + 看一次 diff，三项全过才算包可用。

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

最后更新: 2026-08-17（项目初始化时建立）
