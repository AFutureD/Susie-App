import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpRuntime } from './acp'
import type { Logger } from '../util/logger'

const silentLog: Logger = { info: () => {}, error: () => {} }

/**
 * 假 ACP agent：走 ndjson JSON-RPC，session/new 回报默认模型 agent-default，
 * 收到的 session/set_config_option 参数逐行落 CALL_LOG 文件（测试断言用）；
 * FAIL_SET=1 时 set 请求回 JSON-RPC error（模拟 agent 拒绝切换）；
 * PID_FILE 写入自身 pid（dispose 收尸断言用）；IGNORE_SIGTERM=1 时忽略 SIGTERM（模拟卡死 agent）。
 */
function fakeAgent(): { cmd: string; args: string[]; callLog: string; pidFile: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'susie-acp-test-'))
  const file = path.join(dir, 'agent.mjs')
  const callLog = path.join(dir, 'set-calls.ndjson')
  const pidFile = path.join(dir, 'agent.pid')
  writeFileSync(
    file,
    `import fs from 'node:fs'
import readline from 'node:readline'
if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, String(process.pid))
if (process.env.IGNORE_SIGTERM === '1') process.on('SIGTERM', () => {})
const rl = readline.createInterface({ input: process.stdin })
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n')
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
      break
    case 'session/new':
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-1', configOptions: [{
        id: 'model', name: 'Model', type: 'select', value: 'agent-default',
        options: [{ value: 'agent-default', name: 'Agent Default' }, { value: 'target-model', name: 'Target' }],
      }] } })
      break
    case 'session/set_config_option':
      fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(msg.params) + '\\n')
      if (process.env.FAIL_SET === '1') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'set failed' } })
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: {} })
      }
      break
    default:
      if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} })
  }
})
`,
    'utf-8',
  )
  return { cmd: process.execPath, args: [file], callLog, pidFile, dir }
}

function setCalls(callLog: string): { configId: string; value: string }[] {
  if (!existsSync(callLog)) return []
  return readFileSync(callLog, 'utf-8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { configId: string; value: string })
}

function makeRuntime(model: string | null, extraEnv: Record<string, string> = {}) {
  const agent = fakeAgent()
  const runtime = new AcpRuntime({
    cmd: agent.cmd,
    args: agent.args,
    env: { CALL_LOG: agent.callLog, PID_FILE: agent.pidFile, ...extraEnv },
    cwd: agent.dir,
    mcpUrl: null,
    mcpName: 'susie',
    model,
    log: silentLog,
  })
  return { runtime, callLog: agent.callLog, pidFile: agent.pidFile }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('AcpRuntime 默认模型应用', () => {
  let dispose: (() => Promise<void>) | null = null
  afterEach(async () => {
    await dispose?.()
    dispose = null
  })

  it('配置模型与 agent 默认不同：newSession 后应用为配置值', async () => {
    const { runtime, callLog } = makeRuntime('target-model')
    dispose = () => runtime.dispose()
    await runtime.newSession(null)
    expect(await runtime.currentModel()).toBe('target-model')
    expect(setCalls(callLog)).toEqual([{ sessionId: 'sess-1', configId: 'model', value: 'target-model' }])
  })

  it('未配置模型：不发 set 请求，保持 agent 默认', async () => {
    const { runtime, callLog } = makeRuntime(null)
    dispose = () => runtime.dispose()
    await runtime.newSession(null)
    expect(await runtime.currentModel()).toBe('agent-default')
    expect(setCalls(callLog)).toEqual([])
  })

  it('配置模型与 agent 默认相同：不发多余 set 请求', async () => {
    const { runtime, callLog } = makeRuntime('agent-default')
    dispose = () => runtime.dispose()
    await runtime.newSession(null)
    expect(await runtime.currentModel()).toBe('agent-default')
    expect(setCalls(callLog)).toEqual([])
  })

  it('agent 拒绝切换：会话照常建立，降级到 agent 默认', async () => {
    const { runtime } = makeRuntime('target-model', { FAIL_SET: '1' })
    dispose = () => runtime.dispose()
    await expect(runtime.newSession(null)).resolves.toBe('sess-1')
    expect(await runtime.currentModel()).toBe('agent-default')
  })
})

describe('AcpRuntime.dispose 子进程回收', () => {
  it('正常 agent：dispose 后进程退出', async () => {
    const { runtime, pidFile } = makeRuntime(null)
    await runtime.newSession(null)
    const pid = Number(readFileSync(pidFile, 'utf-8'))
    expect(processAlive(pid)).toBe(true)

    await runtime.dispose()

    // SIGTERM 生效的 agent 应在短时间内退出
    await vi.waitFor(() => expect(processAlive(pid)).toBe(false), { timeout: 3000 })
  })

  it('表征已知债务：忽略 SIGTERM 的 agent 在 dispose 后成为孤儿（P6 停机加固改为限时 SIGKILL 收尸）', async () => {
    const { runtime, pidFile } = makeRuntime(null, { IGNORE_SIGTERM: '1' })
    await runtime.newSession(null)
    const pid = Number(readFileSync(pidFile, 'utf-8'))
    expect(processAlive(pid)).toBe(true)

    await runtime.dispose()

    // 现状：child.kill() 发出 SIGTERM 即返回，不等退出也不升级 SIGKILL —— 进程泄漏。
    // P6 修复后本用例的断言翻转为「限时内被 SIGKILL 收尸」。
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(processAlive(pid)).toBe(true)

    // 测试自清理，防止孤儿进程泄漏出测试运行
    process.kill(pid, 'SIGKILL')
    await vi.waitFor(() => expect(processAlive(pid)).toBe(false), { timeout: 3000 })
  })
})
