# Susie for macOS

> Chat with agents on Telegram through ACP and Codex — now as a macOS desktop app.

Susie 桌面版（TypeScript / Electron）。迁移计划与决策见
[docs/developer/tasks/260722T1917-migrate-macos-desktop-app](./docs/developer/tasks/260722T1917-migrate-macos-desktop-app/TASK.md)。

## 开发

```bash
npm install
npm run dev            # vite dev server + tsdown --watch + electron
npm run dev -- --headless   # 菜单栏常驻模式（不开窗口）
```

## 构建与打包

```bash
npm run build          # typecheck + main/preload + renderer
npm run check          # typecheck + lint + format:check + vitest
npm run smoke          # headless 冒烟：启动即自检退出
npm run test:e2e       # Playwright E2E（先 npm run build）
npm run pack           # electron-builder --dir（本地验证）
npm run dist           # dmg + zip
```

## 结构

```
src/main/       Electron 主进程（服务核心宿主）
src/preload/    contextBridge（sandbox + CJS）
src/renderer/   React UI（Vite 8 + Tailwind 4）
src/shared/     IPC 契约与共享类型
scripts/dev.mjs Dev 编排（vite + tsdown watch + electron 自动重启）
```
