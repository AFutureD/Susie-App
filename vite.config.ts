import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type PluginOption } from 'vite'

// 只在生产构建注入 CSP（dev 下 react-refresh 需要内联预导语，无法满足 script-src 'self'）。
function prodCsp(): PluginOption {
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
  ].join('; ')

  return {
    name: 'susie:prod-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return {
        html,
        tags: [
          {
            tag: 'meta',
            injectTo: 'head-prepend',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          },
        ],
      }
    },
  }
}

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), tailwindcss(), prodCsp()],
  server: {
    port: 5175,
    strictPort: true,
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'esnext',
    sourcemap: true,
  },
})
