// Dev 编排：vite dev server（renderer）+ tsdown --watch（main/preload）+ electron。
// main/preload 产物变化后自动重启 electron；应用正常退出则整个 dev 会话结束。
import { spawn } from 'node:child_process'
import { existsSync, watch } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import electronPath from 'electron'
import { createServer } from 'vite'

const root = path.resolve(import.meta.dirname, '..')
const RENDERER_URL = 'http://localhost:5175'
const MAIN_ENTRIES = ['dist/main/index.js', 'dist/main/index.mjs']
const PRELOAD_ENTRIES = ['dist/preload/index.cjs', 'dist/preload/index.js']

// 透传 `npm run dev -- --headless` 之类的应用参数
const appArgs = process.argv.slice(2)

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') })
await server.listen()
server.printUrls()

const tsdownBin = path.join(root, 'node_modules', '.bin', 'tsdown')
const tsdown = spawn(tsdownBin, ['--watch'], { cwd: root, stdio: 'inherit' })

function entryReady(candidates) {
  return candidates.some((p) => existsSync(path.join(root, p)))
}

while (!entryReady(MAIN_ENTRIES) || !entryReady(PRELOAD_ENTRIES)) {
  // oxlint-disable-next-line no-await-in-loop -- 轮询等待首次构建产物，顺序等待是本意
  await delay(200)
}
// 首次产物落盘后再稍等，避免读到写了一半的文件
await delay(300)

let electronProc = null
let restarting = false
let shuttingDown = false

function launchElectron() {
  electronProc = spawn(String(electronPath), ['.', ...appArgs], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER_URL: RENDERER_URL },
  })
  electronProc.on('exit', (code) => {
    if (restarting || shuttingDown) return
    console.log(`[dev] app exited (code=${code ?? 0}), stopping dev session`)
    void shutdown(code ?? 0)
  })
}

let restartTimer = null
function scheduleRestart() {
  if (shuttingDown) return
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    console.log('[dev] main/preload rebuilt, restarting electron…')
    restarting = true
    const prev = electronProc
    if (prev && prev.exitCode === null) {
      prev.once('exit', () => {
        restarting = false
        launchElectron()
      })
      prev.kill()
    } else {
      restarting = false
      launchElectron()
    }
  }, 400)
}

for (const dir of ['dist/main', 'dist/preload']) {
  watch(path.join(root, dir), { recursive: true }, () => scheduleRestart())
}

async function shutdown(code) {
  shuttingDown = true
  clearTimeout(restartTimer)
  electronProc?.kill()
  tsdown.kill()
  await server.close()
  process.exit(code)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

launchElectron()
