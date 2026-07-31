import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AssistantConfig, Config, ScheduledTask } from '../../shared/config'
import type { MessagePart, TaskRunRecord } from '../../shared/messages'
import type { AgentRuntime, AgentTurn } from '../agents/types'
import type { ConfigStore } from '../config/store'
import { AppDatabase } from '../db/database'
import { TaskRunRepo } from './task-run-repo'
import { TaskScheduler, type TaskSchedulerDeps } from './scheduler'

// 调度器行为测试：假时钟直接驱动 tick（不依赖真实定时器），runtime/投递可控。

const MONDAY_9AM = new Date(2026, 6, 27, 9, 0).getTime() // 2026-07-27 周一 09:00 本地时区

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 't1',
    name: '晨报',
    content: '汇总昨天的要点',
    assistant_id: 'default',
    schedule: '* * * * *',
    targets: [{ channel: 'tg', chat_id: 'P:1' }],
    enabled: true,
    ...overrides,
  }
}

function makeConfig(tasks: ScheduledTask[], assistants?: AssistantConfig[]): Config {
  return {
    channels: {},
    manager_bots: {},
    assistants: assistants ?? [{ id: 'default', agent_id: 'codex' }],
    bindings: [],
    users: [],
    auto_review: { content: 'x', agent_id: 'codex' },
    scheduled_tasks: tasks,
  }
}

interface RuntimeScript {
  /** 完成输出；与 failWith 互斥 */
  text?: string
  failWith?: string
  /** prompt 前的闸门（重叠/在跑用例手动放行） */
  gate?: Promise<void>
  /** 捕获实际收到的 prompt 文本（skill 渲染用例） */
  onPrompt?: (text: string) => void
}

function stubRuntime(script: RuntimeScript): AgentRuntime {
  return {
    newSession: async () => 'sess',
    listModels: async () => [],
    currentModel: async () => null,
    setModel: async () => true,
    cancel: async () => {},
    prompt(text: string): AsyncGenerator<AgentTurn> {
      script.onPrompt?.(text)
      return (async function* () {
        if (script.gate !== undefined) await script.gate
        if (script.failWith !== undefined) {
          yield { status: 'failed', parts: [], error: script.failWith }
          return
        }
        yield { status: 'completed', parts: [{ kind: 'text', text: script.text ?? '结果' }], error: null }
      })()
    },
    dispose: async () => {},
  }
}

function makeHarness(options: {
  tasks: ScheduledTask[]
  assistants?: AssistantConfig[]
  runtime?: RuntimeScript
  failSendTo?: string[]
  now?: number
}) {
  const config = makeConfig(options.tasks, options.assistants)
  const emitted: TaskRunRecord[] = []
  const sends: { channelId: string; chatId: string; parts: MessagePart[] }[] = []
  const scopes: string[] = []
  const runs = new TaskRunRepo(new AppDatabase(':memory:'))
  let clock = options.now ?? MONDAY_9AM

  const deps: TaskSchedulerDeps = {
    store: { current: config } as unknown as ConfigStore,
    runs,
    mcpName: 'susie',
    createRuntime: async (_assistant, mcpScope) => {
      scopes.push(mcpScope)
      return stubRuntime(options.runtime ?? {})
    },
    sendMessage: async (input) => {
      if ((options.failSendTo ?? []).includes(input.chatId)) throw new Error('通道未运行')
      sends.push(input)
      return {}
    },
    emit: (record) => emitted.push(record),
    log: { info: () => {}, error: () => {} },
    now: () => clock,
  }
  const scheduler = new TaskScheduler(deps)
  return {
    scheduler,
    emitted,
    sends,
    scopes,
    runs,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

/** 等待执行落定（emit 两次：running + 结论） */
async function settled(emitted: TaskRunRecord[], count = 2): Promise<void> {
  await vi.waitFor(() => {
    expect(emitted.length).toBeGreaterThanOrEqual(count)
  })
}

describe('TaskScheduler.tick', () => {
  it('到点触发：留痕 running → ok，agent 未经 MCP 投递时输出兜底投递到全部目标', async () => {
    const h = makeHarness({
      tasks: [
        makeTask({
          targets: [
            { channel: 'tg', chat_id: 'P:1' },
            { channel: 'tg', chat_id: 'G:-2' },
          ],
        }),
      ],
      runtime: { text: '今日要点' },
    })
    h.scheduler.tick()
    await settled(h.emitted)

    expect(h.emitted[0]?.status).toBe('running')
    expect(h.emitted[0]?.trigger).toBe('schedule')
    const final = h.emitted.at(-1)
    expect(final?.status).toBe('ok')
    expect(final?.result).toBe('今日要点')
    expect(final?.deliveries).toEqual([
      { channel: 'tg', chatId: 'P:1', ok: true, message: null },
      { channel: 'tg', chatId: 'G:-2', ok: true, message: null },
    ])
    expect(h.sends.map((send) => send.chatId)).toEqual(['P:1', 'G:-2'])
    expect(h.sends[0]?.parts).toEqual([{ kind: 'text', text: '今日要点' }])
    expect(h.runs.latest('t1')?.status).toBe('ok')
  })

  it('停用的任务不触发；分钟不匹配不触发（错过即跳过）', () => {
    const h = makeHarness({
      tasks: [makeTask({ enabled: false }), makeTask({ id: 't2', schedule: '30 8 * * *' })],
    })
    h.scheduler.tick() // 09:00：t1 停用，t2 只在 08:30
    expect(h.emitted).toHaveLength(0)
  })

  it('同一分钟内的重复 tick 只触发一次', async () => {
    const h = makeHarness({ tasks: [makeTask()] })
    h.scheduler.tick()
    h.scheduler.tick()
    await settled(h.emitted)
    expect(h.emitted.filter((record) => record.status === 'running')).toHaveLength(1)
  })

  it('上次未跑完则本次跳过（防重叠），完成后恢复', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = makeHarness({ tasks: [makeTask()], runtime: { gate, text: '慢结果' } })

    h.scheduler.tick()
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1))
    expect(h.scheduler.statuses()[0]?.running).toBe(true)

    h.advance(60_000)
    h.scheduler.tick() // 在跑 → 跳过
    expect(h.emitted).toHaveLength(1)

    release()
    await settled(h.emitted)
    expect(h.emitted.at(-1)?.status).toBe('ok')

    h.advance(60_000)
    h.scheduler.tick() // 已完成 → 恢复触发
    await vi.waitFor(() => expect(h.emitted.filter((record) => record.status === 'running')).toHaveLength(2))
  })

  it('agent 失败：记录 error，不投递', async () => {
    const h = makeHarness({ tasks: [makeTask()], runtime: { failWith: '模型超载' } })
    h.scheduler.tick()
    await settled(h.emitted)
    const final = h.emitted.at(-1)
    expect(final?.status).toBe('error')
    expect(final?.error).toBe('模型超载')
    expect(h.sends).toHaveLength(0)
  })

  it('assistant 不存在：记录 error', async () => {
    const h = makeHarness({ tasks: [makeTask({ assistant_id: 'ghost' })] })
    h.scheduler.tick()
    await settled(h.emitted)
    expect(h.emitted.at(-1)?.status).toBe('error')
    expect(h.emitted.at(-1)?.error).toContain('assistant 不存在')
  })

  it('部分目标投递失败：状态 ok，明细留痕；全部失败：状态 error', async () => {
    const partial = makeHarness({
      tasks: [
        makeTask({
          targets: [
            { channel: 'tg', chat_id: 'P:1' },
            { channel: 'tg', chat_id: 'G:-2' },
          ],
        }),
      ],
      failSendTo: ['G:-2'],
    })
    partial.scheduler.tick()
    await settled(partial.emitted)
    const ok = partial.emitted.at(-1)
    expect(ok?.status).toBe('ok')
    expect(ok?.deliveries.map((delivery) => delivery.ok)).toEqual([true, false])
    expect(ok?.deliveries[1]?.message).toBe('通道未运行')

    const allFail = makeHarness({ tasks: [makeTask()], failSendTo: ['P:1'] })
    allFail.scheduler.tick()
    await settled(allFail.emitted)
    expect(allFail.emitted.at(-1)?.status).toBe('error')
    expect(allFail.emitted.at(-1)?.error).toBe('全部目标投递失败')
  })
})

describe('MCP 自主投递（noteDelivery 归因）', () => {
  it('agent 经 send_message 成功投递：不兜底，明细与摘要归因回执行记录', async () => {
    const holder: { note?: () => void } = {}
    const prompts: string[] = []
    const h = makeHarness({
      tasks: [makeTask()],
      runtime: {
        text: '执行摘要',
        onPrompt: (text) => {
          prompts.push(text)
          holder.note?.()
        },
      },
    })
    holder.note = () =>
      h.scheduler.noteDelivery(h.scopes[0] ?? '', { channel: 'tg', chatId: 'P:1', ok: true, message: null })

    h.scheduler.tick()
    await settled(h.emitted)

    expect(h.scopes[0]).toMatch(/^task-\d+$/)
    // prompt 头部渲染投递目标上下文（agent 据此定位 send_message 的目标）
    expect(prompts[0]).toContain('<TARGETS>')
    expect(prompts[0]).toContain('channel_id: tg, chat_id: P:1')
    const final = h.emitted.at(-1)
    expect(final?.status).toBe('ok')
    expect(final?.result).toBe('执行摘要')
    expect(final?.deliveries).toEqual([{ channel: 'tg', chatId: 'P:1', ok: true, message: null }])
    expect(h.sends).toHaveLength(0) // 已自主投递 → 调度器不再兜底
  })

  it('agent 成功投递且无最终输出：状态 ok，result 为 null', async () => {
    const holder: { note?: () => void } = {}
    const h = makeHarness({
      tasks: [makeTask()],
      runtime: { text: '', onPrompt: () => holder.note?.() },
    })
    holder.note = () =>
      h.scheduler.noteDelivery(h.scopes[0] ?? '', { channel: 'tg', chatId: 'P:1', ok: true, message: null })

    h.scheduler.tick()
    await settled(h.emitted)

    const final = h.emitted.at(-1)
    expect(final?.status).toBe('ok')
    expect(final?.result).toBeNull()
    expect(h.sends).toHaveLength(0)
  })

  it('agent 投递全部失败但有输出：兜底投递，失败明细保留', async () => {
    const holder: { note?: () => void } = {}
    const h = makeHarness({
      tasks: [makeTask()],
      runtime: { text: '要点', onPrompt: () => holder.note?.() },
    })
    holder.note = () =>
      h.scheduler.noteDelivery(h.scopes[0] ?? '', { channel: 'tg', chatId: 'P:9', ok: false, message: '通道未运行' })

    h.scheduler.tick()
    await settled(h.emitted)

    const final = h.emitted.at(-1)
    expect(final?.status).toBe('ok')
    expect(final?.deliveries).toEqual([
      { channel: 'tg', chatId: 'P:9', ok: false, message: '通道未运行' },
      { channel: 'tg', chatId: 'P:1', ok: true, message: null },
    ])
    expect(h.sends.map((send) => send.chatId)).toEqual(['P:1'])
  })

  it('无输出且未投递任何消息：记录 error', async () => {
    const h = makeHarness({ tasks: [makeTask()], runtime: { text: '' } })
    h.scheduler.tick()
    await settled(h.emitted)
    const final = h.emitted.at(-1)
    expect(final?.status).toBe('error')
    expect(final?.error).toContain('任务执行无输出')
    expect(h.sends).toHaveLength(0)
  })
})

describe('技能任务（skill 引用）', () => {
  it('skill 存在：prompt 渲染为「阅读 SKILL.md」指引并携带补充输入', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-sched-skill-'))
    const skillDir = path.join(workDir, '.agents/skills', 'daily')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: daily\n---\n')

    const prompts: string[] = []
    const h = makeHarness({
      tasks: [makeTask({ content: '只看要点', skill: 'daily' })],
      assistants: [{ id: 'default', agent_id: 'codex', work_dir: workDir }],
      runtime: { text: '完成', onPrompt: (text) => prompts.push(text) },
    })
    h.scheduler.tick()
    await settled(h.emitted)

    expect(h.emitted.at(-1)?.status).toBe('ok')
    expect(prompts[0]).toContain('skill「daily」')
    expect(prompts[0]).toContain(path.join(skillDir, 'SKILL.md'))
    expect(prompts[0]).toContain('补充输入：\n只看要点')
    fs.rmSync(workDir, { recursive: true, force: true })
  })

  it('skill 缺失：记 error 执行记录（与 assistant 缺失同型）', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-sched-skill-'))
    const h = makeHarness({
      tasks: [makeTask({ content: '', skill: 'ghost' })],
      assistants: [{ id: 'default', agent_id: 'codex', work_dir: workDir }],
    })
    h.scheduler.tick()
    await settled(h.emitted)

    expect(h.emitted.at(-1)?.status).toBe('error')
    expect(h.emitted.at(-1)?.error).toContain('skill 不存在')
    fs.rmSync(workDir, { recursive: true, force: true })
  })
})

describe('TaskScheduler.runNow / statuses', () => {
  it('手动执行：立即触发（停用任务也可），在跑/不存在拒绝', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = makeHarness({ tasks: [makeTask({ enabled: false })], runtime: { gate, text: 'x' } })

    expect(h.scheduler.runNow('ghost')).toEqual({ ok: false, message: '任务不存在：ghost' })
    expect(h.scheduler.runNow('t1')).toEqual({ ok: true })
    expect(h.emitted[0]?.trigger).toBe('manual')
    expect(h.scheduler.runNow('t1')).toEqual({ ok: false, message: '任务正在执行中' })

    release()
    await settled(h.emitted)
  })

  it('statuses：下次触发时间随 enabled 变化，lastRun 来自历史库', async () => {
    const h = makeHarness({
      tasks: [makeTask({ schedule: '0 9 * * *' }), makeTask({ id: 't2', schedule: '0 9 * * *', enabled: false })],
    })
    h.scheduler.runNow('t1')
    await settled(h.emitted)

    const [first, second] = h.scheduler.statuses()
    // 09:00 当口起算，严格晚于 now → 次日 09:00
    expect(first?.nextRunTs).toBe(new Date(2026, 6, 28, 9, 0).getTime())
    expect(first?.running).toBe(false)
    expect(first?.lastRun?.status).toBe('ok')
    expect(second?.nextRunTs).toBeNull()
    expect(second?.lastRun).toBeNull()
  })
})
