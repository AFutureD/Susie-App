import { defineConfig } from 'tsdown'

// main 走 ESM（Electron ≥ 28 支持 ESM 入口）；preload 在 sandbox 下必须是 CJS。
export default defineConfig([
  {
    entry: { index: 'src/main/index.ts' },
    outDir: 'dist/main',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    deps: { neverBundle: ['electron'] },
    dts: false,
    sourcemap: true,
    clean: true,
  },
  {
    entry: { index: 'src/preload/index.ts' },
    outDir: 'dist/preload',
    format: 'cjs',
    platform: 'node',
    target: 'node22',
    deps: { neverBundle: ['electron'] },
    dts: false,
    sourcemap: true,
    clean: true,
  },
])
