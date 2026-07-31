import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagerBotConfig } from '../../../shared/config'
import type { InboundEnvelope } from '../../../shared/messages'
import type { ConfigRef } from '../../config/store'
import type { TgManagedBotUpdated } from './bot-api'
import { Backoff, TelegramManagerBotChannel, type TelegramManagerBotDeps } from './manager-bot'

// 脚本化 fetch：按 Bot API method 名路由；handler 返回值包成 { ok: true, result }，
// 返回 Response 则原样使用。尊重 init.signal——stop() 的 abort 必须能打断挂起的长轮询。
type Handler = (body: Record<string, unknown>) => unknown
interface Call {
  method: string
  body: Record<string, unknown>
}

function stubTelegram(handlers: Record<string, Handler>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
      const method = String(url).split('/').pop() ?? ''
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      calls.push({ method, body })
      const handler = handlers[method]
      const result = await new Promise((resolve, reject) => {
        if (init.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        if (handler === undefined) {
          resolve(new Response(JSON.stringify({ ok: false, error_code: 404, description: `no handler: ${method}` })))
          return
        }
        Promise.resolve()
          .then(() => handler(body))
          .then(resolve, reject)
      })
      if (result instanceof Response) return result
      return new Response(JSON.stringify({ ok: true, result }))
    }),
  )
  return calls
}

/** 永不 resolve（直到 abort）的 handler：模拟无新消息的长轮询挂起 */
const hang = (): Promise<never> => new Promise<never>(() => {})

const ME = { id: 42, is_bot: true, first_name: 'Mgr', username: 'mgr_bot', can_manage_bots: true }

function makeChannel(handlers: Record<string, Handler>, overrides: Partial<TelegramManagerBotDeps> = {}) {
  const calls = stubTelegram(handlers)
  const settingsRef: ConfigRef<ManagerBotConfig> = {
    path: 'manager_bots.mgr',
    current: { token: 'T:mgr', managing: [] },
    onChange: () => () => {},
  }
  const onMessage = vi.fn<(envelope: InboundEnvelope) => void>()
  const onManagedBotUpdate = vi.fn<(managerId: string, token: string, ev: TgManagedBotUpdated) => void>()
  const statuses: string[] = []
  const channel = new TelegramManagerBotChannel({
    id: 'mgr',
    settingsRef,
    onMessage,
    onManagedBotUpdate,
    onStatus: (status) => statuses.push(`${status.state}:${status.detail ?? ''}`),
    log: { info: () => {}, error: () => {} },
    timings: { manageModeRecheckMs: 10, conflictRetryMs: 10, backoffBaseMs: 5, backoffCapMs: 10 },
    ...overrides,
  })
  return { channel, calls, onMessage, onManagedBotUpdate, statuses }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TelegramManagerBotChannel', () => {
  it('can_manage_bots 未开启：error 状态且不进 getUpdates；开启后自愈到 running', async () => {
    let manageMode = false
    const { channel, calls } = makeChannel({
      getMe: () => ({ ...ME, can_manage_bots: manageMode ? true : undefined }),
      getUpdates: () => hang(),
    })
    await channel.start()

    await vi.waitFor(() => {
      expect(channel.status().state).toBe('error')
    })
    expect(channel.status().detail).toContain('Bot Management Mode')
    expect(calls.filter((c) => c.method === 'getUpdates')).toHaveLength(0)

    manageMode = true
    await vi.waitFor(() => {
      expect(channel.status().state).toBe('running')
    })
    expect(channel.status().detail).toBe('@mgr_bot')
    await channel.stop()
  })

  it('managed_bot update → onManagedBotUpdate 回调，offset 推进到 update_id + 1', async () => {
    const ev: TgManagedBotUpdated = {
      user: { id: 7, is_bot: false, first_name: 'Boss' },
      bot: { id: 999, is_bot: true, first_name: 'Child', username: 'child_bot' },
    }
    let round = 0
    const { channel, calls, onManagedBotUpdate } = makeChannel({
      getMe: () => ME,
      getUpdates: () => {
        round += 1
        return round === 1 ? [{ update_id: 5, managed_bot: ev }] : hang()
      },
    })
    await channel.start()

    await vi.waitFor(() => {
      expect(onManagedBotUpdate).toHaveBeenCalledWith('mgr', 'T:mgr', ev)
    })
    await vi.waitFor(() => {
      const second = calls.filter((c) => c.method === 'getUpdates')[1]
      expect(second?.body['offset']).toBe(6)
    })
    const first = calls.find((c) => c.method === 'getUpdates')
    expect(first?.body['allowed_updates']).toEqual(['message', 'managed_bot'])
    expect(first?.body['offset']).toBeUndefined()
    await channel.stop()
  })

  it('私聊消息 record-only 上抛；群消息忽略；/start 直接回复且回复也入历史', async () => {
    let round = 0
    const { channel, onMessage, calls } = makeChannel({
      getMe: () => ME,
      getUpdates: () => {
        round += 1
        if (round > 1) return hang()
        return [
          {
            update_id: 1,
            message: {
              message_id: 10,
              date: 1700,
              from: { id: 7, is_bot: false, first_name: 'Boss' },
              chat: { id: 7, type: 'private', first_name: 'Boss' },
              text: '/start',
            },
          },
          {
            update_id: 2,
            message: {
              message_id: 11,
              date: 1700,
              from: { id: 8, is_bot: false, first_name: 'Other' },
              chat: { id: -100, type: 'supergroup', title: 'Group' },
              text: 'hello',
            },
          },
        ]
      },
      sendMessage: () => ({ message_id: 99, date: 1701, chat: { id: 7, type: 'private' } }),
    })
    await channel.start()

    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledTimes(2)
    })
    const inbound = onMessage.mock.calls[0]?.[0]
    expect(inbound?.message.channelId).toBe('mgr')
    expect(inbound?.message.chatId).toBe('P:7')
    expect(inbound?.message.senderId).toBe('7')
    expect(inbound?.message.out).toBe(false)

    const reply = onMessage.mock.calls[1]?.[0]
    expect(reply?.message.out).toBe(true)
    expect(reply?.message.id).toBe('99')
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1)
    await channel.stop()
  })

  it('getUpdates 401 → 终态 error，循环退出', async () => {
    const { channel, calls } = makeChannel({
      getMe: () => ME,
      getUpdates: () => new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })),
    })
    await channel.start()

    await vi.waitFor(() => {
      expect(channel.status().detail ?? '').toContain('token 已失效')
    })
    const countWhenFailed = calls.filter((c) => c.method === 'getUpdates').length
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls.filter((c) => c.method === 'getUpdates')).toHaveLength(countWhenFailed)
    await channel.stop()
  })

  it('stop() 立即中止挂起的长轮询', async () => {
    const { channel } = makeChannel({ getMe: () => ME, getUpdates: () => hang() })
    await channel.start()
    await vi.waitFor(() => {
      expect(channel.status().state).toBe('running')
    })

    const stopped = channel.stop()
    await expect(
      Promise.race([stopped, new Promise((_r, reject) => setTimeout(() => reject(new Error('stop 超时')), 1000))]),
    ).resolves.toBeUndefined()
    expect(channel.status().state).toBe('stopped')
  })
})

describe('Backoff', () => {
  it('指数递增封顶，reset 归位', () => {
    const backoff = new Backoff(100, 400)
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([100, 200, 400, 400])
    backoff.reset()
    expect(backoff.next()).toBe(100)
  })
})
