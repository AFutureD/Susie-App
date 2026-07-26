# Susie-App 架构重构 · 审阅与提交指南（2026-07-26）

全部变更在**工作树未提交**（121 文件，+6352/−3645）。按 AGENTS.md 纪律，请 review 后自行提交（提交信息含人工确认）。

## 快速验证

```bash
npm run check && npm run build && npm run smoke && npm run test:e2e
```

最终状态：check 246 用例全过（另 5 个 codex 集成用例默认 skip）、smoke 通过、e2e 9/9。
建议另跑一次 `npm run test:codex`（真实 codex，耗 token）——本轮改了 codex-app-server 的 close 语义（等子进程退出 + SIGKILL 升级）。

## 分阶段 diff

scratchpad 下的 `phase-P*.patch` 是各阶段完成时的**累积** `git diff HEAD` 快照。看单个阶段的净变更：

```bash
interdiff phase-P4.3.patch phase-P5.1.patch   # 例：P5.1 的净变更
```

或整体一把 review：`git diff HEAD`。

| 阶段 | 内容 | 新增测试 |
|---|---|---|
| P0 | 测试网：卡片文案快照、core 补测（DND/fall-through/auto 无 owner）、迁移表征、acp dispose 收尸 | approval-card.test / migrations.test 等 |
| P1 | IPC 契约路由：`shared/ipc/{channel,envelope,contract,bridge}.ts` + `main/ipc/router.ts` + handlers 六域；通道改名 `susie:<group>.<method>`；preload 前缀门卫（删白名单）；renderer Proxy 客户端；删旧 `registerIpcHandlers` | envelope / router / contract 类型断言 |
| P2 | `app.ts` 组合根（index.ts → 15 行）；WindowManager / TrayManager / UpdaterManager 类化；删 lifecycle.ts | updater-manager.test 重写（去 resetModules） |
| P3 | 类型化事件：`shared/ipc/events.ts` + `WindowManager.broadcast`；删 ServiceEmit 与 `shared/ipc.ts`；renderer `onIpcEvent/useIpcEvent`；AGENTS.md IPC 段更新 | — |
| P4 | 持久化：`db/migrations.ts`（user_version，迁移 1–4 含 envelope_v）+ AppDatabase；Message/Approval/AutoReview 三 repo，HistoryStore 删除 | runMigrations 框架测试 + repo 测试拆分 |
| P5 | Channel 接口 + ChannelFactory + telegram/ 子目录；`copy/bot-copy.ts` 文案表 + `core/approval-card.ts`（快照零 diff 验收）；频道页 per-type 表单 | **hub.test（首次覆盖，并抓出 restart 双 spawn 孤儿 bug——已修）** |
| P6 | AgentProvider + AgentManager（owns() 有序认领 + overview 行归属跟随解析）；`AgentsOverview = AgentInfo[]` 破坏性翻转 + agents 页同构列表；停机加固（SerialGate/waitChildExit、SIGTERM→SIGKILL、disposeAll await、mcp.stop 限时） | manager.test；acp dispose 测试翻转为「必须收尸」 |
| P7 | ChatManager 六阶段管线 + `core/permission-gate.ts`（GateDecision 取代四布尔；**core.test.ts 一行未改全绿**）；bindings 按会话 diff（行为变更：改无关绑定不再销毁全部会话） | permission-gate 矩阵 + bindings diff spec |
| P8 | renderer 数据层：toast（9 处 alert 清零）、useIpcQuery（5 处重复订阅收敛为共享缓存）、useConfigMutation、configAtom(key)、`shared/equal.ts`；bindings-panel 拆 4 文件、onboarding 拆 3 文件（均 <280 行） | — |
| P9 | `shared/nav.ts` 导航同源（app/smoke/e2e）；TASK.md 六处漂移修正 + 重构里程碑；AGENTS.md 架构段刷新 | — |

## 需要重点看的行为变更（其余均为等价重构）

1. **hub 重启修复**（P5.2）：restart-required 字段变更时不再双 spawn（旧代码会泄漏一个继续 polling 的孤儿实例 → Telegram 409）。
2. **bindings 按会话失效**（P7.3）：改一条无关绑定不再销毁全部活跃会话；只比较 `assistant_id`（only_mention/send_output 本就现读即时生效）。
3. **停机收尸**（P6.3）：agent 子进程 SIGTERM 3s 无效升级 SIGKILL；service.stop 各段带预算。
4. **IPC 校验失败语义**（P1）：契约层校验失败从「静默 reject」变为带 cause 的 Error（信封还原）；用户可编辑载荷（token 为空等表单校验）仍走 handler 内 safeParse → `{ok:false,message}` 内联展示，UX 不变。
5. **AgentsOverview 形状**（P6.2）：`{codex, acp[]}` → `AgentInfo[]`（内部 IPC，无外部消费者）。
6. **agent 行去重**（P6）：ACP registry 里的 `codex` 条目不再与内置 codex 重复显示（行归属跟随解析规则）。

## 刻意未做（可选后续）

- FTS5 搜索迁移（node:sqlite FTS5 本机验证可用；设计：迁移 5 + try/catch 探测 + LIKE 回退）
- `errorMessage()` 全仓清扫（本轮已顺手换掉动过的 ~19 处，剩 ~25 处旧惯用语）
- CONFIG_SECTIONS 表驱动 diffConfigPaths/resolveConfigPath（收益小）
- MCP server bearer token（127.0.0.1:9898 仍无鉴权）
