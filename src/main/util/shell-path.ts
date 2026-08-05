import { spawn } from 'node:child_process'
import type { Logger } from './logger'

const MARKER = '__SUSIE_PATH__'
const DEFAULT_TIMEOUT_MS = 5000

/**
 * GUI 启动（Dock/Finder）的打包应用只继承 launchd 的最小 PATH
 * （/usr/bin:/bin:/usr/sbin:/sbin），用户经 shell 配置注入的目录
 * （mise/nvm/homebrew 的 node 等）全部缺失——npx 分发的 ACP agent
 * 会 spawn ENOENT。启动时跑一次 login shell 解析真实 PATH 合并进
 * process.env.PATH，之后所有子进程（AcpRuntime 等 {...process.env}）自然继承。
 *
 * 失败只降级不阻塞启动：终端启动/dev 模式 PATH 本来就是全的。
 */
export async function mergeLoginShellPath(
  log: Logger,
  options: { shell?: string; timeoutMs?: number } = {},
): Promise<boolean> {
  if (process.platform === 'win32') return false
  const shell = options.shell ?? process.env['SHELL'] ?? (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  try {
    // -l -i：mise/nvm 常只在交互 rc（.zshrc）里激活，仅 -l 会漏；
    // 输出用 marker 包裹，防 rc 脚本向 stdout 打印噪音
    // ${PATH} 必须带大括号：紧跟 marker 时 shell 会把 "PATH__SUSIE..." 整体当变量名
    const output = await loginShellOutput(shell, `printf '%s' "${MARKER}\${PATH}${MARKER}"`, timeoutMs)
    const start = output.indexOf(MARKER)
    const end = output.lastIndexOf(MARKER)
    if (start === -1 || end <= start) throw new Error('输出中找不到 PATH 标记')
    const resolved = output.slice(start + MARKER.length, end)
    if (resolved === '') throw new Error('login shell 返回空 PATH')
    process.env['PATH'] = mergePathEntries(process.env['PATH'] ?? '', resolved)
    log.info(`PATH 已合并 login shell（${shell}）环境`)
    return true
  } catch (error) {
    log.error(
      `解析 login shell（${shell}）PATH 失败，npx 分发的 ACP agent 可能不可用：${error instanceof Error ? error.message : String(error)}`,
    )
    return false
  }
}

/** login shell 优先（用户配置的 node 等要排在系统目录之前），保留当前 PATH 独有项，去重去空 */
export function mergePathEntries(current: string, resolved: string): string {
  const entries: string[] = []
  const seen = new Set<string>()
  for (const entry of [...resolved.split(':'), ...current.split(':')]) {
    if (entry === '' || seen.has(entry)) continue
    seen.add(entry)
    entries.push(entry)
  }
  return entries.join(':')
}

function loginShellOutput(shell: string, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // 交互式 shell 会启用 job control。若它与终端启动的 Susie 共用 session，
    // 会把自己的进程组设为终端前台；退出后 npm/dev 收不到 Ctrl-C，下一次
    // 读取终端还会因 SIGTTIN 被挂起。独立 session 保留 -i 的 rc 加载能力，
    // 同时从操作系统层面隔离其终端 job control。
    const child = spawn(shell, ['-l', '-i', '-c', command], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`login shell 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString()
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve(output)
    })
  })
}
