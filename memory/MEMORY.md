# dsh-web-vscode 项目记忆

## 项目身份（重要）

- **GitHub 仓库**：https://github.com/wuruihi/dsh-vscode （仓库名 `dsh-vscode`）
- **市场扩展 ID**：`wurui.dsh-web-vscode`（display: DeepSeek Harness (DSH)）
- **为什么名字不一致**：Marketplace 的扩展名跨发布者全局唯一，`dsh-vscode` 已被他人占用（且不可见/已下架），改名 `dsh-web-vscode`。查询验证方法：`extensionquery` API，filterType 7 = 精确 ID，filterType 10 = 模糊名。
- **发布者**：`wurui`（用户 GitHub: wuruihi，ID 176995251）
- 命令 ID / 配置键前缀仍是 `dsh-vscode.*`（内部标识，勿改，改了破坏用户键位/设置）

## IDE 能力桥（v0.4.0，V2 第一项）

- 架构：模型工具（ide_active_file / ide_selection / ide_diagnostics / ide_open_file）
  → DSH 插件 `~/.dsh/plugins/dsh-ide-bridge`（defineTool + ctx.tools.register，参照 better-sidebar 备份插件）
  → HTTP 127.0.0.1:3187 + Bearer token（发现文件 `~/.dsh/dsh-vscode-ide.json`，扩展启动写、退出删）
  → dsh-vscode 扩展 `src/ide/bridge.ts`（vscode.languages.getDiagnostics / activeTextEditor / showTextDocument）
- 插件依赖解析：宿主别名 + 兜底 junction（插件目录 node_modules → ~/.dsh/profiles/node_modules）
- 插件改动需重启 dsh web；扩展改动需 Reload Window；两者可独立降级（桥不可达时工具报友好错误）
- defineTool 契约：{name, description, parameters:{p:{type,required,description}}, output:{schema}, async execute(args, exec){exec.signal.throwIfAborted()}}

## V2 完成状态（0.4.5 收口）

- 排版（0.3.x）：14px 中文下限 + 结构化写作，已闭环
- live 状态条移到输入框上方（0.4.2）
- IDE 能力桥（0.4.0/0.4.1）：见上节；0.4.1 修诊断过滤的 Windows 路径失配（必须 `Uri.file()` 规范化后 `toString()` 比对）
- @ 文件引用（0.4.3/0.4.4）：`@` 触发补全（防抖 120ms + reqId 对账）→ 📎 chip → 协议 `{type:"file"}` 占位 → 宿主 `expandFileParts` 展开（2 万字符截断）。气泡只显示一句话 + chips：fold 层识别 `[引用文件 X]` 块抽标签丢正文，对历史消息同样生效
- dsh-ui 渲染器补齐（0.4.5）：mermaid（自研 SVG 子集渲染器：graph TD/LR、三种节点形、实线/虚线/带标签边，最长路分层布局，解析失败降级代码块）+ plot（白名单表达式编译 + 采样折线）。quiz/scene3d 有意不做（频率低/依赖重）
- 遗留：市场最新仍是 0.3.6，0.4.x 系列 vsix 未上传市场（用户手动网页上传，时机由用户定）

## 发布流程

- 本地构建：`corepack pnpm compile`（门控）→ `build` → `vsce package --no-dependencies`
- 发布方式：**市场网页手动上传 vsix**（marketplace.visualstudio.com/manage → + New extension）。
  未走 PAT/vsce login 路线：用户登不上 dev.azure.com；网页上传不需要 PAT。
- 发布后索引传播：查询 API 分钟级可见，详情页/CLI 安装要几分钟~几小时
- git tag：`v0.3.4` 已打

## 网络环境（本机）

- GitHub / Marketplace 直连被重置，走本地代理 `127.0.0.1:7890`（Clash）
- git 已在仓库级配置 http.proxy/https.proxy；curl 用 `-x http://127.0.0.1:7890`
- `code --install-extension <ID>` 走 CLI 直连市场会失败，用本地 vsix 装或等索引后 GUI 装

## 技术要点沉淀

- `session.list` 不带标题 → 标题用 globalState 持久缓存 + 8 并发后台补全（v0.3.4 启动优化）
- dsh-ui 围栏渲染：3 级 JSON 修复（strict → cheap 笔误 → items-merge 结构修复），对齐本体容错
- markdown：remark-breaks 保真单换行（中文分段命门）+ 中文 14px 字号下限 + 行高 1.7
- 助手消息无气泡框（Claude Code 布局公式，从其 webview CSS 逆向）
- 消息流上滑自动加载：scrollTop<=40 触发 + 高度锚定防视口跳动 + 4s 看门狗

## 环境事实

- 仓库路径：`D:\repos\dsh-vscode`；构建产物 vsix 只保留最新一个
- git 身份：wuruihi / 176995251+wuruihi@users.noreply.github.com（noreply 防邮箱泄露）
- 旧原型 `weinibuliu.dsh-vsc` 已卸载退役
