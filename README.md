# dsh-vscode

VSCode 客户端插件，连接本机常驻的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh web`，默认 127.0.0.1:3080）。与 DSH 浏览器 GUI 共享同一实例：会话、插件生态（genui / agent-teams / workflow）、持久化全部互通。

## 功能

- **会话**：列表 / 切换 / 新建 / 重命名，与 GUI 双向同步
- **对话流**：流式正文 + 思考折叠 + 工具卡片（当前工具 live 指示 + FocusView 式折叠）
- **审批 / 提问**：webview 内直接应答；多端并发自动收敛（他端已答的卡自动撤）
- **上下文附加**：`Alt+K` 把选区 / 活动文件作为真实内容块发送（非 `@path` 假引用）；支持粘贴图片
- **原生 diff**：编辑类工具卡上「查看 diff」→ VSCode 原生 diff 编辑器（逆序反推原文，URI 带版本号防陈旧缓存）
- **queue / steer**：运行中排队追加或中途引导，队列可见可删
- **模型选择**：provider 分组 + reasoning effort（发送 `m.id`）

## 前置

1. 本机已装 `@deepseek-ai/dsh` 并可运行 `dsh web`（默认端口 3080）
2. 模型 / 凭据在 DSH 侧配置（`~/.dsh`），插件不经手密钥

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `dsh-vscode.baseUrl` | `http://127.0.0.1:3080` | dsh web 地址 |
| `dsh-vscode.autoStart` | `true` | 探测不到时尝试拉起（Windows） |
| `dsh-vscode.nodePath` | 系统 node | 拉起用 node 路径 |
| `dsh-vscode.dshBinPath` | 全局安装的 bin.js | 拉起用 dsh CLI 路径 |

## 开发

```bash
pnpm install
pnpm compile   # 类型检查
pnpm build     # esbuild 打包
pnpm smoke     # 协议冒烟（需 dsh web 在跑）
pnpm package   # 打 .vsix
```

架构与协议契约见 `docs/design.md`，项目规范见 `AGENTS.md`。
