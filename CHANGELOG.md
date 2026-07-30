# Changelog

## v0.5.1 · 2026-07-30

- 定时任务单次执行超时从 10 分钟放宽到 1 小时。
- Telegram channel 贴文入历史列表；bot 不参与 channel 会话循环（避免自答）。
- 修正 Telegram Topic 会话的 chat_id 判定。

## v0.5.0 · 2026-07-27

首启引导重做 + Agent 准备 + 菜单栏修复：

- 引导新增第 4 步「准备 Agent」（会话绑定之后）：检测本机 codex / claude CLI，检测到即推荐对应 agent（内置 Codex / ACP registry 的 Claude Agent），可复用其登录；安装由用户手动点击触发（复用 Agent 页的安装与进度流），「跳过此步」只跳过本步不关闭向导。
- 引导进入条件改为「启动时 config.toml 是否存在」（`ConfigState.firstRun`，缺失事实在写入默认文件前采样）：文件已存在（无论内容多不完整）或损坏（错误横幅负责）都不弹引导；localStorage 完成标记与按配置内容恢复步骤的逻辑一并移除。删除 config.toml 重启即可重新触发引导。
- codex agent 不再从仓库 node_modules 的 vendor 二进制解析（解析顺序收敛为 已下载 → PATH），开发环境体验与正式版一致。
- 修复 macOS 顶部菜单栏丢失：菜单栏常驻应用经 dock.hide()（Accessory）后重新打开窗口时，先 `dock.show()` 恢复激活策略再显示窗口；并显式设置应用菜单（App / Edit / Window，dev 附 View），保证 Cmd+C/V 等快捷键始终可用。

杂项：

- 新增 `agents.detectCli` IPC（PATH 扫描，不起子进程）；agent 安装进度条与事件订阅抽成共享件，Agent 页与引导共用。

## v0.4.0 · 2026-07-27

新增「技能」模块：

- 按 全局（~）/ 助手（工作目录）两个维度管理本地 agent skills，支持搜索；v1 认 `.agents/skills`、`.claude/skills`、`.pi/skills` 三个容器目录，每行标明所在目录，可删除、可在 Finder 打开。
- 「获取技能」子页：从 GitHub 仓库（owner/repo 或链接，含 /tree/<分支>/<子目录>）列出仓库内全部 SKILL.md 技能后选择安装；从 skillhubs registry（skill.drojian.dev）关键词搜索并安装。安装目标可选 全局/助手 × 容器目录，已存在时二次确认覆盖。
- 助手卡片新增「技能」弹窗：只显示该助手的 agent 能读取的技能（映射对齐 vercel-labs/skills Supported agents，如 claude 只读 `.claude/skills`）。
- 定时任务「任务内容」支持「使用技能」：候选仅限所选助手可读，执行时助手先阅读该技能的 SKILL.md 再执行，可附补充输入；技能缺失时该次执行记失败留痕。

杂项：

- 新增共享弹窗组件 Modal，统一既有三处手写弹窗壳。

## v0.3.0 · 2026-07-26

新增「定时任务」模块：

- 按计划让指定助手执行任务文本，最终输出发送到选中的一个或多个会话（私聊/群聊，可跨频道）。
- 调度存标准 5 字段 cron（本地时区），UI 用预设控件编辑（每 N 分钟 / 每小时 / 每天 / 每周 / 每月），弹窗内实时预览描述与下次执行时间；手写的复杂表达式按「自定义」原样保留。
- 错过的点位一律跳过不补跑；「执行」按钮随时手动触发（任务在跑时拒绝）。
- 每次执行留痕：结果全文、触发方式、每个目标的投递成败，单任务保留最近 500 条；「执行历史」子页可回溯、实时刷新、按任务筛选。
- 任务定义存 config.toml `[[scheduled_tasks]]`，与其余配置一样支持热加载与 Raw 编辑；执行用一次性 agent 运行时（不注入 susie 工具，超时 10 分钟）。

杂项：

- 表单新增 FieldGroup：修复 label 包裹复合控件时，首个按钮的可访问名被标签文本顶替、点击标签误触按钮的问题。

## v0.2.0 · 2026-07-26

架构重构：契约优先 IPC、组合根与 Manager 分层、版本化 DB 迁移与领域分仓、Channel/Agent 抽象、ChatManager 管线化、renderer 数据层。修复通道热更双 spawn 孤儿实例与 agent 子进程退出不收尸两个既有 bug。

## v0.1.1 – v0.1.7 · 2026-07

macOS 桌面版首发与迭代：Telegram 频道、助手与会话绑定、用户权限档位、智能自动审核、消息历史、日志、自动更新。
