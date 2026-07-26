# 技能模块

* Task: 260726T2252-skills-module
* Author: [Huanan](https://github.com/AFutureD)
* Status: DONE
* Type: FEAT
* Related: [260726T1823-scheduled-tasks](../260726T1823-scheduled-tasks)

## 一句话

新增「技能」模块：按 全局/助手 两个维度管理本地 agent skills（`.agents/skills`、`.claude/skills`、`.pi/skills`），支持从 GitHub 仓库与 skillhubs registry 获取安装；助手卡片可查看其 agent 可读的技能；定时任务的任务内容支持选用技能执行。

## 想要的结果（Outcome）

| # | 结果 | 验收 |
|---|---|---|
| 1 | 技能页按 全局（~）/ 助手（生效工作目录）两维度列出本地技能，支持搜索，每行标明所在容器目录 | `skills.listLocal` IPC + 目录徽标；扫描仅认三个容器目录 |
| 2 | 从 GitHub 仓库（owner/repo 或链接）列出技能并安装到 全局/助手 × 三目录之一 | `skills.listRepo` / `skills.installFromRepo`（codeload tarball + SKILL.md 扫描） |
| 3 | 从 skillhubs registry 关键词搜索并安装 | `skills.searchRegistry` / `skills.installFromRegistry`（固定 registry `https://skill.drojian.dev`） |
| 4 | 助手卡片「技能」弹窗只显示该 agent 可读的技能（如 claude 不显示 `.agents/skills` 中的） | `skillDirsForAgent` 静态表（对齐 vercel-labs/skills Supported agents）+ `skills.listForAssistant` |
| 5 | 定时任务「任务内容」支持 自定义 / 使用技能 两种模式；技能候选仅限所选助手可读 | `scheduled_tasks[].skill` 字段 + 执行期渲染「阅读 SKILL.md 并遵循」提示词 |
| 6 | 技能可删除、可在 Finder 打开；UI 不展示 symlink 等文件系统细节 | `skills.remove` / `skills.reveal` |

## 关键决策（与理由）

- **agent→目录映射 = 静态表**，对齐 vercel-labs/skills Supported agents 的 project 列（用户指定数据源）；目录超出 v1 三容器的 agent（goose 等）如实置空；未收录 id 走 Universal（`.agents/skills`）。claude 只读 `.claude/skills`（用户拍板）。
- **技能是文件系统态，不进 config**：IPC 按需查询 + 刷新按钮，无 watcher/推送事件；skillhubs registry 固定常量 `https://skill.drojian.dev`（用户拍板），config 零改动。
- **定时任务技能执行 = 通用提示词**（阅读 <绝对路径>/SKILL.md 并严格遵循 + 可选补充输入）：ACP 协议无原生技能输入，通用提示词对全部 agent 一致有效；skill 缺失在执行期记 error 记录（与 assistant 缺失同型），不做 schema 级校验。
- **GitHub 获取走 codeload tarball**（HEAD→main→master 兜底，无 API 限流），解包后复用本地 SKILL.md 扫描器；解包结果做 30 分钟会话缓存供安装复用。零新依赖：解压复用系统 unzip/tar（上移 `util/archive.ts`），frontmatter 手写极简解析。
- **UI 不展示文件系统细节**（用户拍板）：不显示 symlink/realpath；同一技能出现在多个容器目录时各自成行（维度即目录），不去重。

## 交付状态（2026-07-27）

全部达成。质量门：`npm run check`（352 用例，含新增 映射表/扫描器/仓库解析/registry 映射/prompt 渲染/管理器/调度器技能路径/表单编码 ~65 个）+ build + smoke + e2e 11/11 全绿。已按用户指示提交；仅提交不发布（不打 tag、不推送）。

落点速览：共享类型与 agent→目录静态映射 `shared/skills.ts`；任务 skill 引用 `shared/config.ts`（`taskSkillSchema`，content 放宽为「skill 模式下可空」）；主进程 `main/skills/{scan,github,skillhubs,task-prompt,manager}.ts`（本地扫描 / codeload tarball / 固定 registry / fire-time prompt 渲染 / 解包会话缓存安装）+ `util/archive.ts`（extractArchive 自 acp/registry.ts 上移）；IPC `skills.*` 八通道；UI `/skills` 与 `/skills/remote` 两页、助手卡片「技能」弹窗、任务表单「自定义 | 使用技能」切换；新增共享 `components/modal.tsx` 并迁移既有三处手写弹窗。

备注：skillhubs registry（skill.drojian.dev）在开发沙箱网络不可达（用户侧已验证可用）；不可达时搜索/安装内联展示失败信息，不影响其余功能。

## 参照

- 远程清单 + 安装蓝本：[registry.ts](/src/main/agents/acp/registry.ts)（远程拉取 + 落盘缓存 + 安装清单）
- 执行链路：[scheduler.ts](/src/main/tasks/scheduler.ts)（一次性 runtime + error record）
- UI 先例：[tasks/](/src/renderer/src/pages/tasks/)（卡片 + 子页 + 弹窗）、[agents.tsx](/src/renderer/src/pages/agents.tsx)（远程行 + 安装）
- 映射数据源：[vercel-labs/skills Supported agents](https://github.com/vercel-labs/skills#supported-agents)；skillhubs registry API（`/api/skills?search=`、`/api/skills/{name}`、`/api/skills/{name}/{version}/download`）
