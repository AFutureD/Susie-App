# AGENTS.md

Susie 桌面版（TypeScript / Electron）。迁移计划、架构决策与里程碑见
[docs/developer/tasks/260722T1917-migrate-macos-desktop-app/TASK.md](./docs/developer/tasks/260722T1917-migrate-macos-desktop-app/TASK.md)，
行为参照 Python 源仓库 `~/Developer/susie`。

## 常用命令

```bash
npm run dev          # vite dev + tsdown --watch + electron（改 main/preload 自动重启）
npm run check        # typecheck + oxlint + prettier --check + vitest
npm run build        # typecheck + 全量构建
npm run smoke        # 隔离环境无头自检（renderer/IPC/热加载 全链路）
npm run test:e2e     # Playwright 驱动真实 Electron（需先 npm run build）
npm run format       # prettier 全仓格式化
npm run pack         # electron-builder --dir（无签名本地包）
npm run test:codex   # 真实 codex 集成测试（含 MCP 回环；耗 token，手动跑）
```

提交前跑 `npm run check && npm run build && npm run smoke && npm run test:e2e`。

## 结构与约定

- `src/main/` 主进程 = 服务核心宿主（config/channels/agents/mcp/history 按目录分层）；`src/preload/` 必须保持 CJS（sandbox）；`src/renderer/` React UI；`src/shared/` 三端共享的类型与 zod schema。
- IPC：契约集中在 `src/shared/ipc.ts`。新通道 = Schema 加类型 + 通道清单登记（preload 白名单）+ `src/main/ipc.ts` 实现。渲染进程只经 `window.susie` 访问。
- 配置：`ConfigStore`（`src/main/config/store.ts`）是唯一入口——消费方持 `ConfigRef`（`store.ref('channels.<id>')`），不要缓存配置拷贝；所有写操作带 `expectedVersion`。配置文件 `~/.config/susie/config.toml`（`SUSIE_CONFIG_DIR` 可覆盖，测试/冒烟必须覆盖，避免碰真实配置）。
- 字段名与 TOML 保持 snake_case（兼容 Python 版配置）。
- UI 文案走 React Intl（`src/renderer/src/i18n/zh-Hans.ts`），语义色用 Tailwind token（`bg-surface` / `text-ink` / `border-line` 等，定义在 `styles.css`）。
- main 产物为 ESM（`dist/main/index.mjs`），`electron` 由运行时提供（tsdown `deps.neverBundle`）。
- 测试隔离：任何会启动应用的测试都必须设置 `SUSIE_CONFIG_DIR` 与 `SUSIE_USER_DATA_DIR`（后者决定单实例锁，不隔离会被正在运行的实例踢掉）。
- E2E 约定：表单 `fill` 之后先 `toHaveValue` 断言再点提交（等 React 提交输入状态，避免竞态）。
- 图标：`build/icon.icns` 与 `src/main/tray-icon.ts`（base64 模板图标）由 `icon.svg → qlmanage → sips → iconutil` 流水线生成。
- 停机纪律：任何网络/子进程操作出现在退出路径上都必须 `withTimeout`（`src/main/util/async.ts`）；will-quit 里异步清理完成后用 `setImmediate(() => app.quit())` 重新触发退出。
- codex 注入 susie MCP 时必须带 `default_tools_approval_mode: 'approve'`，否则非交互模式下工具调用会被自动取消。
- 历史库用 `node:sqlite`（Electron ≥43 内置），不要引入需要 rebuild 的原生模块。
