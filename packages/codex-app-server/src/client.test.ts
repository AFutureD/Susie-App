// 用假 app-server（node 脚本 + sh 垫片）做全链路验证：
// initialize 握手、thread/turn 流、steer、审批自动应答、model/list。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Codex } from './api'

const FAKE_SERVER = String.raw`
import readline from 'node:readline'

const rl = readline.createInterface({ input: process.stdin })
const write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
let turnSeq = 0

rl.on('line', (line) => {
  if (line.trim() === '') return
  const msg = JSON.parse(line)
  const { id, method, params } = msg

  if (method === 'initialize') {
    write({ id, result: { userAgent: 'fake/1.0', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' } })
    return
  }
  if (method === 'initialized') return
  if (method === 'thread/start') {
    write({ id, result: { thread: { id: 'thread-1' } } })
    return
  }
  if (method === 'model/list') {
    write({
      id,
      result: {
        data: [
          { model: 'fake-model', displayName: 'Fake Model', description: '', hidden: false, isDefault: true },
          { model: 'hidden-model', displayName: 'Hidden', description: '', hidden: true, isDefault: false },
        ],
        nextCursor: null,
      },
    })
    return
  }
  if (method === 'turn/start') {
    turnSeq += 1
    const turnId = 'turn-' + turnSeq
    write({ id, result: { turn: { id: turnId, items: [], status: 'inProgress', error: null } } })
    // 先请求一次命令审批（验证默认 handler 自动 accept 并回写 result）
    write({ id: 'srv-req-' + turnId, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId, itemId: 'i0' } })
    return
  }
  if (method === 'turn/steer') {
    write({ id, result: { turnId: params.expectedTurnId } })
    // steer 输入并入当前 turn：补一个 item 后完成
    const text = params.input.map((item) => item.text ?? '').join(' ')
    write({ method: 'item/completed', params: { threadId: 'thread-1', turnId: params.expectedTurnId, item: { id: 'i2', type: 'agentMessage', text: 'steered: ' + text, phase: null, memoryCitation: null }, completedAtMs: 0 } })
    write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: params.expectedTurnId, items: [], status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null } } })
    return
  }
  if (method === 'turn/interrupt') {
    write({ id, result: {} })
    write({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: params.turnId, items: [], status: 'interrupted', error: null, startedAt: null, completedAt: null, durationMs: null } } })
    return
  }
  // 客户端对服务端请求的应答（审批 result）：转发成通知供测试断言
  if (method === undefined && id !== undefined) {
    write({ method: 'test/serverRequestResolved', params: { forId: id, result: msg.result } })
    return
  }
  if (id !== undefined) write({ id, result: {} })
})
`

let dir: string
let codexShim: string

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-server-test-'))
  const serverPath = path.join(dir, 'fake-app-server.mjs')
  fs.writeFileSync(serverPath, FAKE_SERVER, 'utf-8')
  // client 以 `codexPath [--config k=v...] app-server --listen stdio://` 方式 spawn，
  // 用 sh 垫片吞掉参数并转交 node 脚本
  codexShim = path.join(dir, 'codex')
  fs.writeFileSync(codexShim, `#!/bin/sh\nexec "${process.execPath}" "${serverPath}"\n`, 'utf-8')
  fs.chmodSync(codexShim, 0o755)
  const probe = spawnSync(codexShim, ['--version'], { timeout: 5000 })
  if (probe.error !== undefined) throw probe.error
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('CodexClient + Codex（假 app-server）', () => {
  it('initialize 握手返回服务端元数据', async () => {
    const codex = new Codex({ codexPath: codexShim })
    await codex.ensureInitialized()
    expect(codex.metadata.userAgent).toBe('fake/1.0')
    codex.close()
  })

  it('model/list 走同一连接并过滤 hidden 由调用方决定', async () => {
    const codex = new Codex({ codexPath: codexShim })
    const models = await codex.models()
    expect(models.data.map((model) => model.model)).toEqual(['fake-model', 'hidden-model'])
    codex.close()
  })

  it('turn 流：审批自动 accept，steer 并入当前 turn 后完成', async () => {
    const codex = new Codex({ codexPath: codexShim })
    const thread = await codex.threadStart({ cwd: '/tmp' })
    expect(thread.id).toBe('thread-1')

    const turn = await thread.turn('hello')
    expect(turn.id).toBe('turn-1')

    // 服务端在 turn/start 后立刻发出审批请求；默认 handler 自动 accept
    const echo = await codex.client.nextGlobalNotification()
    expect(echo.method).toBe('test/serverRequestResolved')
    expect(echo.params).toMatchObject({ result: { decision: 'accept' } })

    await turn.steer('more input')

    const events: string[] = []
    let steeredText = ''
    for await (const notification of turn.stream()) {
      events.push(notification.method)
      if (notification.method === 'item/completed') {
        steeredText = (notification.params as { item: { text: string } }).item.text
      }
    }
    expect(events).toEqual(['item/completed', 'turn/completed'])
    expect(steeredText).toBe('steered: more input')
    codex.close()
  })

  it('interrupt 使 turn 以 interrupted 完成', async () => {
    const codex = new Codex({ codexPath: codexShim })
    const thread = await codex.threadStart({ cwd: '/tmp' })
    const turn = await thread.turn('hello')
    await turn.interrupt()
    let status = ''
    for await (const notification of turn.stream()) {
      if (notification.method === 'turn/completed') {
        status = (notification.params as { turn: { status: string } }).turn.status
      }
    }
    expect(status).toBe('interrupted')
    codex.close()
  })

  it('进程退出时所有在途等待者被 TransportClosedError 唤醒', async () => {
    const codex = new Codex({ codexPath: codexShim })
    await codex.ensureInitialized()
    const pending = codex.client.request('thread/list', {})
    // 直接杀进程（绕过 close 的優雅关闭标记）
    ;(codex.client as unknown as { proc: { kill: () => void } }).proc.kill()
    await expect(pending).rejects.toMatchObject({ name: 'TransportClosedError' })
    codex.close()
  })
})
