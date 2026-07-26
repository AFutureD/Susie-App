# 定时任务模块

* Task: 260726T1823-scheduled-tasks
* Author: [Huanan](https://github.com/AFutureD)
* Status: DONE
* Type: FEAT
* Related: [260726T1601-refactor-architecture-from-lobehub](../260726T1601-refactor-architecture-from-lobehub)

## 一句话

让指定 assistant 按计划执行一段任务文本，把结果发送到选定的一个或多个会话（私聊/群聊），可增删改、启停、手动执行、看状态、回溯历史。

## 想要的结果（Outcome）

| # | 结果 | 验收 |
|---|---|---|
| 1 | 任务可多条并存，支持增、改、删、启停，与 assistants 同一套配置体验（乐观并发、热加载、Raw 编辑器可见） | 任务定义存 config.toml `[[scheduled_tasks]]` |
| 2 | 到点用所选 assistant 执行一次任务文本，最终输出原样发送到所有选中会话 | 一次性 runtime + `chatManager.sendMessage` 逐目标投递 |
| 3 | 时间能力对齐 cron（分 时 日 月 周），但 UI 只呈现预设控件（每 N 分钟/每小时/每天/每周/每月），预览态显示人类可读描述、编辑态才展开控件 | 存储为标准 5 字段 cron 字符串；预设 ⇄ cron 互转测试 |
| 4 | 会话目标多选，私聊/群聊混选、可跨频道 | targets 数组（channel + chat_id） |
| 5 | 任务状态一眼可见：在跑与否、下次执行时间、最近一次结果 | `tasks.statuses` IPC + 卡片徽章 |
| 6 | 每次执行留痕可回溯：触发方式、结果全文、失败原因、每个目标的投递成败 | SQLite `task_runs` 表 + 任务页历史区（实时刷新、可展开、可按任务筛选） |
| 7 | 手动「执行」按钮立即跑一次（在跑时拒绝并提示） | `tasks.run` IPC |

## 关键决策（与理由）

- **错过不补跑**：应用睡眠/未运行期间到点的任务一律跳过（用户拍板）；手动「执行」是兜底。调度器因此无持久化状态——分钟对齐 tick，每 tick 现读 `store.current.scheduled_tasks`（与 chat-manager 现读 bindings 同一手法），改配置即时生效。
- **schedule 存 cron 表达式而非结构化对象**：TOML 手改友好、天然对齐 cron 语义；表达式永不直接暴露在 UI——预设控件生成/反解析，认不出的手写表达式按「自定义」原样保留。自实现 cron 子集（`*`、`*/step`、列表、区间；日/周同限按 vixie 取 OR），不引第三方库。
- **执行用一次性 runtime，不注入 susie MCP**（蓝本 auto-review）：结果由调度器统一投递，避免 agent 自行发消息导致重复/失控；专用任务指令（无人值守、输出即结果），不复用聊天版 SYSTEM 模板。超时 10 分钟，退出路径限时收尾。
- **定义与历史分家**：任务定义是配置（config.toml），执行历史是数据（历史库 `task_runs`，每任务留最近 500 条，task_name 存快照使删除任务后历史仍可读）。

## 交付状态（2026-07-26）

全部达成。质量门：`npm run check`（275 用例，含新增的 cron/调度器/执行历史仓/预设互转 ~30 个）+ build + smoke + e2e 10/10 全绿。已按用户指示随 v0.3.0 提交并发布（见 [CHANGELOG.md](/CHANGELOG.md)）。

落点速览：任务定义 `config.toml [[scheduled_tasks]]`（schema 校验 + 乐观并发 + 热加载）；cron 子集 `shared/schedule.ts`；调度与执行 `main/tasks/scheduler.ts`（一次性 runtime，无 MCP，10 分钟超时）；历史 `main/tasks/task-run-repo.ts`（task_runs，每任务留 500 条）；IPC `tasks.statuses / tasks.runs / tasks.run` + `tasks.run` 事件；UI `renderer/pages/tasks/`（卡片列表 + 执行时间弹窗编辑 + 「添加会话」弹窗复用绑定件 ChatPickerModal + 执行历史子页 `/tasks/history`）。

## 参照

- 执行链路蓝本：[auto-review.ts](/src/main/core/auto-review.ts)（一次性 runtime + 全程留痕 + 实时上报）
- 投递与落库：[chat-manager.ts](/src/main/core/chat-manager.ts) `sendMessage`
- UI 先例：[assistants.tsx](/src/renderer/src/pages/assistants.tsx)（卡片 + 内联表单）、[intelligence.tsx](/src/renderer/src/pages/intelligence.tsx)（历史区 + 事件合并）
