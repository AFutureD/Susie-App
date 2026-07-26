# 借鉴 LobeHub Desktop 重构 Susie 架构

* Task: 260726T1601-refactor-architecture-from-lobehub
* Author: [Huanan](https://github.com/AFutureD)
* Status: DONE
* Type: FEAT
* Related: [260722T1917-migrate-macos-desktop-app](../260722T1917-migrate-macos-desktop-app)

## 一句话

学习 `~/Developer/lobehub`（重点 `apps/desktop`）的架构与其过去一年的演进，把普适实践（类型安全 IPC、组合根、接口驱动分层、版本化迁移、测试网先行）按 Susie 的体量落地，消化迁移期积累的架构债。

## 想要的结果（Outcome）

| # | 结果 | 验收 |
|---|---|---|
| 1 | 新增 IPC 通道 = 契约加一行 + handler 一处；漏实现是**编译错误**而非运行时静默失败 | `IpcHandlers` 映射类型 + tsc |
| 2 | 全部 invoke 通道有运行时入参校验；主进程抛错到 renderer 不丢 cause/code | 契约 zod + 错误信封往返测试 |
| 3 | 加一种通道类型（如 Slack）不动 core：config union + `channels/<平台>/` + 注册一行 + 表单登记一项 | core 对 `TelegramBotChannel` 的 import 清零 |
| 4 | 加一种 agent 类型不再散改 `service.ts` 四处分支 | `AgentProvider` owns() 认领 + `AgentManager` 门面 |
| 5 | 数据库演进有版本化迁移（不再手写 `PRAGMA table_info` if 链）；审批/审核持久层归 core 域 | `db/migrations.ts`（user_version）+ 三 repo |
| 6 | `ChatManager.process()` 的 8 个关注点可独立测试；权限门矩阵有直测 | 六阶段 driver + `permission-gate.test.ts`；**core.test.ts 一行不改全绿** |
| 7 | 退出不留孤儿 agent 子进程 | SIGTERM → `waitChildExit` 限时 → SIGKILL；收尸测试 |
| 8 | renderer 不再 N 处订阅同一事件各自全量重查；alert/expectedVersion 样板收编 | `useIpcQuery` 共享缓存 / `useConfigMutation` / toast |
| 9 | 改一条无关绑定不再销毁全部活跃会话 | bindings 按会话 diff + spec 测试 |
| 10 | 加/删页面只改一处导航清单 | `src/shared/nav.ts`（app/smoke/e2e 同源） |

刻意**不做**（规模不配）：middleware 框架、AgentRuntime 基类、Channel capability flags、react-query、主进程 i18n 框架、`app://` 协议、共享包抽取 / 隔离 workspace（LobeHub 的规模驱动项）。

## 交付状态（2026-07-26）

全部达成。质量门：`npm run check`（246 用例，含新增的门矩阵/迁移/hub/收尸/manager 等 ~40 个）+ build + smoke + e2e 9/9 全绿。变更留在工作树，**按 [AGENTS.md](/AGENTS.md) 纪律人工 review 后提交**；审阅要点（含 6 处行为变更清单）见 [review-guide.md](./assets/review-guide.md)。

顺带修复两个既有 bug（都是新测试抓出）：

- hub 在 restart-required 字段热更时双重 spawn，旧通道实例成孤儿继续 polling（Telegram 409 风险）；
- agent 子进程 dispose 只发信号不等退出，退出路径可能留孤儿进程。

## 关键决策（与理由）

- **契约优先 zod 路由，否决 LobeHub 式装饰器 IPC**：oxc-transform 只支持 legacy decorators；类型跨双 tsconfig 需要伪包手法；且 LobeHub 模式无运行时校验。契约放 `shared/ipc/contract.ts` 延续本仓「契约集中在 shared」的约定，renderer 只 type-only import（zod 不进 bundle）。
- **preload 用前缀门卫（`susie:` / `susie-evt:`）替代白名单数组**：白名单不是安全边界（全部敏感通道本就在名单内），真边界是 contextBridge 只暴露 invoke/on；契约由「main 按 `typeof ipcContract` 注册 + renderer 受 `IpcClient` 约束」两端锁死，不存在第三份清单。
- **用户可编辑载荷（token/users 等）的语义校验留在 handler 内**，以 `{ ok:false, message }` 返回供表单内联展示——表单校验是 UX 路径，不是异常。
- **SusieService 不整体解散**：组装 + 停机顺序是它的正当职责；只把 agent 工厂/缓存/安装分发抽成 `AgentManager`。延迟闭包解环**保留**（两阶段 init 是倒退）。
- **AgentProvider 用有序列表 + owns() 认领而非 Map**：ACP 拥有任意 registry id，必须末位兜底；overview 行归属跟随解析规则（registry 里的 `codex` 条目不与内置行重复显示）。
- **审批卡片不按通道各自渲染**：`MessagePart[]` 已是通道中立表现货币，只抽**文案**到 `copy/bot-copy.ts`（迁移验收 = 卡片快照测试零 diff）。
- **迁移框架用 `PRAGMA user_version`，拒绝 applied-ids 元表**（桌面单写者够用）；迁移 1–3 幂等固化既有库现状，`envelope_v` 用列而非 JSON 内嵌字段（读路径零风险）。
- **方法论照抄 LobeHub**：先织测试网再动大手术；每步保持 check+build+smoke 绿（里程碑加 e2e）；质量门保持本地纪律，不恢复 CI（29debbe 的决定）。

## 后续（可选，未做）

- FTS5 搜索迁移（node:sqlite FTS5 本机已验证；设计：迁移 + try/catch 探测 + LIKE 回退）
- `errorMessage()` 清扫剩余 ~25 处旧惯用语
- CONFIG_SECTIONS 表驱动 `diffConfigPaths`/`resolveConfigPath`（收益小，可砍）
- MCP server bearer token（127.0.0.1:9898 目前无鉴权）
- `npm run test:codex` 手动验证一次（codex-app-server 的 close 语义本轮有变）

## 参照

- 架构参照：`~/Developer/lobehub/apps/desktop`（App 组合根 / Controller-Service 分层 / 装饰器 IPC / 错误信封 / electron-store 迁移框架）及其 2025-07 → 2026-07 的演进史（400 commits：IPC 三代演进、业务逻辑上移主进程、依赖策略、Next.js 撤退、启动优化）
- 本次会话产出：三份勘察报告（LobeHub 架构 / 演进史 / Susie 现状与 A–G 债务清单）+ 两份设计（IPC 与分层 / 领域解耦），计划文件 `~/.claude/plans/users-huanan-developer-lobehub-pure-frog.md`
