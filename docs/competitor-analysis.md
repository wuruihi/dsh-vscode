# 竞品分析：jager.dsh-vscode（DeepSeek Harness for VS Code）

> 2026-09-02 立项分析。竞品版本 0.12.89（本机安装）/ 0.12.90（源码，github.com/NEXTINDIE/DeepSeek-Harness-for-VS-Code，MIT）。
> 取证方式：源码克隆 + 两个子代理逐行分析 + 本人双线抽查，全部结论有行号级证据。
> 结论已驱动 roadmap.md（Phase 0-4）；本文档作为长期参考保留——移植 chat.css / ICONS / apiClient 设计时常开。

## 1. 总判断

1. **不换竞品**：JSON/dsh-ui 渲染在竞品是架构级缺失（见 §4），且我方独有 IDE 桥、逐工具原生 diff 高频使用。
2. **保留并加深 JSON 渲染**：这是我方唯一护城河（28 组件 + 7 级修复管线 + 回归套件）。
3. **像素级模仿 → 设计系统移植**：抄 MIT 授权的令牌/图标/信息架构，用我方 React 架构重实现，一次到位。像素是快照，设计系统才是生成器；竞品日更，追像素永远慢一拍。
4. **协议断代是 P0**：DSH 0.1.2-alpha.4 已改线协议（dot→slash 端点、events.mux/events.host/respond 全废、单 WS remote.mux、token 换 cookie 认证）。用户将持续升级 DSH 到最新版 → 我方必须双 flavor 自适应。

## 2. 竞品架构速写

```
VS Code 扩展宿主
 ├─ DshHub（门面：状态机扇出 + 流管理 + 全套透传方法）
 │   ├─ DshApiClient：HTTP POST /api/<ns>/<method>（{args} 信封 + cookie）
 │   │                WS /api/remote.mux 单连接多路逻辑流：
 │   │                session/follow | session/control | workspace/follow | $events
 │   ├─ ServerManager：探测→autoStart（dsh 命令→node 直装→npx→npm exec 四级，钉 @alpha）
 │   └─ SessionStore：纯内存投影（会话/事件seq去重/队列/审批/工作区/goal/todos）
 ├─ ChatChannel×N（侧栏×2 + 独立窗口，各自订阅 store → postMessage）
 ├─ @dsh Chat Participant（StreamFollower 折事件流为 markdown + 审批按钮）
 ├─ commitMessage.ts（SCM ✨：staged diff → 创建即归档的一次性会话 → 写回输入框）
 └─ rollbackInstall.ts（幂等装 dsh-git-rollback 进 ~/.dsh/profiles/web + ~/node_modules）
     ↘ 服务端插件：turn/start|end 钩子建 refs/dsh/* 检查点链（GIT_INDEX_FILE 临时索引、
       CAS update-ref、保存点+read-tree 非破坏回退、/undo 反向 apply），web 半经
       DSH client-modules 管线注入回合分隔线
```

工程质量不差：协议迁移有完整记录、能力探测代替版本硬编码、456 行真实仓库 git 测试、seq 三层幂等、serializeEventsForWire 合并 delta、重放门闩快进。

结构性代价：硬绑 alpha 移动靶；写用户全局环境（~/node_modules）；外部启动的 0.1.2+ 服务器拿不到 token 被软排他；多窗口双 spawn 竞态；无虚拟化内存无上界；**流式 O(n²)**（每 delta 整块重跑 marked+DOMPurify+innerHTML）。

## 3. 功能矩阵（要点）

| 维度 | 竞品 | 我方 |
|---|---|---|
| 连接路线 | 接管服务器（4级启动器，钉@alpha） | 复用常驻 3080 + 一键拉起 |
| 协议绑定 | 每版本硬绑一个 DSH 版本 | 锁 rc.2（分析时）→ 本轮改双 flavor |
| @dsh 原生参与者 | ✅（按钮审批/提问） | ❌ |
| dsh-ui/GenUI 围栏 | ❌ 全部落普通代码块 | ✅ 28组件+7级修复 |
| markdown | marked 两行，无表格/标题样式、无高亮 | react-markdown+GFM，无高亮（共同缺口） |
| 流式性能 | O(n²) innerHTML | memo 化段落 |
| 消息操作条 / 统计行 / 上下文条 / 产物卡 / 回合分隔线 | ✅ | ❌（Phase 1 补齐） |
| 子代理 | 目录+下钻+追问/打断 | 徽标计数 |
| @提及 | 文件/智能体/会话 | 仅文件 |
| goal / 四面板 / Cordis / i18n 15 语言 | ✅ | ❌（GUI 承担，不追） |
| IDE 能力桥（4 工具）/ 逐工具原生 diff / 跨会话审批归属 | ❌ | ✅ 独有 |
| 测试纪律 | probe + git 测试 | fence/repair 回归 + smoke |

## 4. JSON 渲染差距根因（源码定案）

- 渲染管线唯一入口 `markdownHtml()` = `marked.parse + DOMPurify.sanitize`（ui.ts:317-324），无自定义 renderer。
- 全源码 grep `dsh-ui|genui` = 0。```dsh-ui 围栏 → `<pre><code class="language-dsh-ui">原文`，pre-wrap 纵向铺满。
- 工具参数原串 `<pre>`（预览 90 字符）、结果截 4000、trajectory `JSON.stringify` 截 8000——全部原文，无树/无高亮/无折叠（仅 `<details>`）。
- 连 markdown 表格/标题/引用样式都没有（chat.css grep = 0），链接无 openExternal。
- 本质：竞品把「对齐 web」理解为功能清单对齐；GUI 渲染核心（genui 插件管线 + micromark 一等公民围栏）无法移植进 marked 两行管线。补齐=重写渲染层。

## 5. 值得长期参考的竞品实现（行号指 0.12.90 源码，克隆于分析时）

- `serializeEventsForWire`（channel.ts:437）合并同块连续 delta；`replaying` 门闩快进（ui.ts:225）
- `deriveStatsFromEvents`（ui.ts:3712）投影丢失时本地兜底统计
- `questionFlows`（ui.ts:4082）重建式 UI 保草稿；`openAnchoredMenu` 视口钳制弹层（ui.ts:3161）
- CSS 内联进 HTML + CSP nonce（channel.ts:1828）；ServiceWorker guard（safety.ts）
- apiClient 的 remote.mux 流实现（open/cancel/item/end/error + 指数退避 + 代际守卫）——Phase 0 蓝本
- dsh-git-rollback（npm 独立包，MIT）：临时 GIT_INDEX_FILE、GIT_OPTIONAL_LOCKS=0、quotepath=false、CAS update-ref、保存点+read-tree、/undo 反向 apply --check 预检

## 6. 不学清单

O(n²) 流式重绘、innerHTML 渲染管线、224KB 单文件 UI、15 语言 i18n、四面板全对等（GUI 就在 3080）、服务器接管 + @alpha 钉死（与我方「复用常驻实例」信念相反）、向用户 ~/node_modules 写全局。
