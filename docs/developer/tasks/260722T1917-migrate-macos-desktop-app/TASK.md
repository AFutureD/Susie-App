# 将 Susie 迁移为 macOS 桌面应用（TypeScript）

* Task: 260722T1917-migrate-macos-desktop-app
* Author: [Huanan](https://github.com/AFutureD)
* Status: DONE
* Type: FEAT

## 背景

Susie 目前是 Python 实现的守护进程（源仓库 `~/Developer/susie`）：通过 Telegram 通道接收消息，交给 Codex / ACP agent 处理，并经内置 MCP server 让 agent 主动回信。本任务将其迁移为 macOS 桌面应用（TypeScript / Electron），**按功能迁移，不做逐行翻译**。

## 目标（Outcome）

一个菜单栏常驻的 macOS 应用，具备：

1. **Channel 管理** — Telegram Bot 通道的新建（token 校验）、编辑（白名单 / 群策略 / only_mention）、启停与实时状态（含 polling 409 冲突暴露）。
2. **Agent 管理** — codex CLI 检测；ACP registry 浏览、安装、更新、卸载（darwin-aarch64/x86_64，处理 quarantine xattr）。
3. **Assistant 管理** — id / agent_id / work_dir / forward_to / 模型 / nunjucks 指令模板；Binding 编辑（channel × chat_ids → assistant）。
4. **对话历史** — 本地 SQLite 持久化全部出入消息与 agent turn 明细；时间线浏览、搜索、实时追加；同时作为 MCP `list_messages` 的数据源。

配置文件 `~/.config/susie/config.toml` 保持兼容（剔除 `telegram_user` 通道与 `api_id`/`api_hash`），支持**热加载**与**配置引用**（见下）。

## 范围

| | 内容 |
|---|---|
| 保留 | Bot 通道语义（白名单/群策略/only_mention/chat_id 编码）、binding 解析、per-chat replier、`/help /new /model` 命令、SYSTEM/PROMPT 模板、内置 MCP（send_message / list_messages / list_chats）、「自己发消息 → 忽略 2 分钟并 cancel」 |
| 放弃 | `telegram_channel`（用户账号通道）及 session/QR 登录/onboard 流程 |
| 新增 | 桌面 UI（四大管理界面）、配置热加载与引用、SQLite 历史、菜单栏常驻、`--headless` |

## 关键决策

### 技术栈

Electron 43 + TypeScript strict。renderer：React 19.2 / React Router 7 / Jotai / Tailwind 4（语义 token）/ React Markdown / React Intl。（原计划的 Radix / Floating UI / Motion / ProseMirror / CodeMirror / KaTeX / Mermaid 未引入——当前自研 80 行 form 组件已够用，需要时再评估。）构建：Vite 8（Rolldown）+ tsdown（main/preload）+ 自研 `scripts/dev.mjs`（electron-vite 5 不支持 Vite 8）。核心依赖：`node-telegram-bot-api`、`packages/codex-app-server`（自研 codex app-server JSON-RPC SDK，替代 `@openai/codex-sdk`）、`@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk`、`nunjucks`、`smol-toml`、`chokidar`、`better-sqlite3`（ChatGPT.app 同款选择）、`chrono-node`、`zod`、`electron-log`。

### 配置引用（ConfigRef）

「引用读取」指**消费方持有指向配置实体的引用**，而非取值插值：

- 主进程唯一 `ConfigStore` 持有当前已校验的不可变 snapshot；
- 消费方经 `ref('channels.<id>')` 取 `ConfigRef`，`.current` 永远解析到最新 snapshot，实体被删则为 `undefined`（持有者自毁）；
- 热加载 = 解析 → 校验 → swap snapshot，按 path 结构比较只通知变化的订阅者；解析失败保留 last-good 并在 UI 报错；
- 字段分两类：read-through（白名单/群策略等，消息到达时读 `current` 即刻生效）与 restart-required（token、drop_pending_updates，由 Hub 在 onChange 中判定重启）；
- `assistants` 数组 load 后建 by-id 索引（`assistants.<id>` 可引用）；
- renderer 侧以 `configAtom(key)`（jotai selectAtom + deepEqual，见 `lib/config-atoms.ts`）按顶层 key 订阅切片，来源仍是 `config.state` 广播的整包快照。

### 已定结论

- 历史存储最终用 **`node:sqlite`**（Electron 43 内置 Node 24.18 已支持）：零原生依赖、零 rebuild、单测直接在本机 Node 跑。放弃 better-sqlite3 的原因：本机 npm 策略阻止 install scripts + Electron/Node 双 ABI 让测试链路复杂；`HistoryStore` 封装完整，日后要换回只动一个文件。
- Telegram polling 409 是**跨进程**风险（老 Python 服务未停 / dev 与正式版并行）：`requestSingleInstanceLock` + 409 状态灯 + 重启通道时 `await stopPolling()`。
- codex 集成改为自研 `packages/codex-app-server`（`codex app-server` JSON-RPC，`turn/interrupt` 取消、`turn/steer` 并入、`model/list` 枚举）；注入 susie MCP **必须带 `default_tools_approval_mode = "approve"`**，否则非交互模式会直接取消工具审批请求（真实 codex 集成测试踩出）。审批策略为 `approvalMode: 'auto_review'`（自动应答审批请求）。
- 模型枚举已动态化：codex 走 `model/list`、ACP 读 session configOptions（`AgentManager` 统一缓存 5 分钟）；assistant 配置的 `models` 仅作 legacy 手改 TOML 的候选兜底。
- 出站富文本用 Telegram `<blockquote expandable>`（HTML parse mode）+ 纯文本降级。
- 语音消息：不捆绑 ffmpeg（省 ~70MB），系统有 `ffmpeg` 则 OGG→WAV，否则原样附带 .oga 文件。
- ACP registry 支持 binary（下载解压 + quarantine 清理）与 npx 两种分发；解压用系统 unzip/tar。
- 退出路径全部带硬超时（will-quit 5s、getMe 15s、stopPolling 3s）；will-quit 里异步清理后须 `setImmediate(() => app.quit())`——同步栈内重入 quit 会被 Electron 吞掉（e2e 踩出）。
- UI 写回 config.toml 不保留手写注释（JS 无 tomlkit 等价物，接受此取舍）。
- 包体问题已解决：codex 二进制改为运行时按需下载（`CodexInstaller`），不再打进安装包。

## 里程碑

| 阶段 | 验收标准 | 状态 |
|---|---|---|
| M0 脚手架 | 空应用可打包、可启动、菜单栏常驻；typed IPC 贯通；`--headless` / smoke 模式可用 | ✅ |
| M1 配置系统 | 外部修改 config.toml 5 秒内生效且不重启；坏配置不中断服务；配置 UI 可编辑 | ✅ |
| M2 最小消息闭环 | 消息通路全链路 + agent 经 MCP 主动 `send_message`（真实 codex 集成测试验证；Telegram 网络侧待真机收发） | ✅ |
| M3 对话历史 | 重启后历史可查；agent 可按自然语言日期范围检索；历史 UI + composer | ✅ |
| M4 ACP | registry 浏览/安装/卸载 + AcpRuntime + Agent 管理 UI（真实 agent 端到端待安装后验证） | ✅ |
| M5 打磨发布 | Assistant/Binding 完整 UI、/model、日志视图、开机自启、签名/公证接线（缺 Developer ID 证书，`npm run dist` + Apple 环境变量即出公证包） | ✅ |

遗留（有意后置）：xterm.js workspace 终端（可选增强）、KaTeX/Mermaid 历史渲染增强、CodeMirror Raw 编辑器升级。（electron-updater 已完成：`UpdaterManager` + 分渠道 GitHub Releases。）

## 后续：260726 架构重构（借鉴 LobeHub Desktop）

2026-07-26 完成一轮全面架构重构（详见当次会话的分阶段 patch 与 AGENTS.md 更新）：

- IPC 契约优先：`shared/ipc/contract.ts`（zod req + phantom res）+ `main/ipc/router.ts`（完整性编译期强制）+ preload 前缀门卫 + renderer Proxy 客户端；错误信封保留 cause 链。
- 主进程分层：`app.ts` 组合根；WindowManager / TrayManager / UpdaterManager 类化（删 lifecycle.ts 全局单例）；SusieService 瘦身为纯组装 + 停机编排。
- 持久化：`db/migrations.ts`（PRAGMA user_version 版本化迁移）+ MessageRepo / ApprovalRepo / AutoReviewRepo 按领域拆分（HistoryStore 解散）。
- Channel 抽象：`channels/types.ts` 接口 + ChannelFactory 注册表（hub 平台无关；顺带修复 restart 双 spawn 孤儿实例 bug）；bot 文案收敛 `copy/bot-copy.ts`。
- Agent Provider：`agents/provider.ts` + `AgentManager`（owns() 有序认领）；`AgentsOverview` 同构为 `AgentInfo[]`；停机加固（SerialGate / waitChildExit / 限时 SIGKILL 收尸）。
- ChatManager 管线化：6 阶段方法 + `core/permission-gate.ts`（GateDecision 取代四布尔）；bindings 变更按会话 diff（不再全量销毁会话）。
- Renderer 数据层：toast、useIpcQuery（共享缓存 + 事件失效）、useConfigMutation、configAtom(key)；bindings-panel / onboarding 拆分。
- 导航清单同源 `shared/nav.ts`（app / smoke / e2e 三处不再各写一份）。

## 参照

- 行为参照：Python 源仓库 `~/Developer/susie`（settings/ChatManager/replier/agent/mcp 各模块）
- 桌面实现参照：`/Applications/ChatGPT.app`（Electron + better-sqlite3 + node-pty + Sparkle）
