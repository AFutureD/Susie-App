# Susie for macOS

> Chat with agents on Telegram through ACP and Codex — now as a macOS desktop app.

Susie 桌面版（TypeScript / Electron）。迁移计划与决策见
[docs/developer/tasks/260722T1917-migrate-macos-desktop-app](./docs/developer/tasks/260722T1917-migrate-macos-desktop-app/TASK.md)。

用户功能与上手路径见 [docs/FEAT.md](./docs/FEAT.md)。

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
npm run pack           # electron-builder --dir（本地验证；无签名、自动更新禁用）
npm run dist           # arm64 + x64 的 dmg + zip（需签名/公证凭证）
```

## 发布

发布一律走 CI（推 `v*` tag 触发 `.github/workflows/release.yml`：构建 arm64 + x64 → Developer ID 签名 →
公证 → 上传 GitHub Release → 产物核对）。**先 bump 版本再打 tag**，CI 会校验两者一致：

```bash
npm version <x.y.z> --no-git-tag-version --workspaces-update=false
git commit -am "chore: v<x.y.z>"
git tag -a v<x.y.z> -m "v<x.y.z>" && git push --follow-tags
```

装好的 app 经 electron-updater 自动升级（15 分钟轮询 + 设置页手动检查）。
凭证配置、本地发布兜底与踩坑记录见 [docs/developer/release.md](./docs/developer/release.md)。

## 结构

```
src/main/       Electron 主进程（服务核心宿主）
src/preload/    contextBridge（sandbox + CJS）
src/renderer/   React UI（Vite 8 + Tailwind 4）
src/shared/     IPC 契约与共享类型
scripts/dev.mjs Dev 编排（vite + tsdown watch + electron 自动重启）
```
