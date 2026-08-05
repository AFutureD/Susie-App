import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Config } from '../../shared/config'
import type { BotIdentity } from '../../shared/messages'
import type { ConfigStore } from '../config/store'
import { BotIdentityRegistry } from './identity'

// identity 缓存的行为测试：fake store（仿 hub.test.ts）+ 按 token 路由的 fetch stub（仿 manager-bot.test.ts）。

function stubGetMe(handler: (token: string) => unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string): Promise<Response> => {
      const token = /\/bot([^/]+)\/getMe$/.exec(String(url))?.[1] ?? ''
      const result = handler(token)
      if (result instanceof Response) return result
      return new Response(JSON.stringify({ ok: true, result }))
    }),
  )
}

function makeRegistry(config: {
  channels?: Record<string, { type: 'telegram_bot'; token: string }>
  manager_bots?: Record<string, { token: string }>
}) {
  let channels = config.channels ?? {}
  const managerBots = config.manager_bots ?? {}
  const listeners: (() => void)[] = []
  const store = {
    get current() {
      return { channels, manager_bots: managerBots } as unknown as Config
    },
    subscribePath: (_path: string, listener: () => void) => {
      listeners.push(listener)
      return () => {}
    },
  } as unknown as ConfigStore

  const emitted: BotIdentity[][] = []
  const registry = new BotIdentityRegistry({
    store,
    emit: (identities) => emitted.push(identities),
    log: { info: () => {}, error: () => {} },
  })
  const setChannels = (next: Record<string, { type: 'telegram_bot'; token: string }>): void => {
    channels = next
    for (const listener of listeners) listener()
  }
  return { registry, emitted, setChannels }
}

const me = (username: string, extra: Record<string, unknown> = {}) => ({
  id: 1,
  is_bot: true,
  first_name: username,
  username,
  ...extra,
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('BotIdentityRegistry', () => {
  it('映射 can_read_all_group_messages：true/false/缺失→null；manager bot 同样入表', async () => {
    stubGetMe((token) => {
      if (token === 't-open') return me('open_bot', { can_read_all_group_messages: true })
      if (token === 't-priv') return me('priv_bot', { can_read_all_group_messages: false })
      return me('plain_bot')
    })
    const { registry } = makeRegistry({
      channels: {
        open: { type: 'telegram_bot', token: 't-open' },
        priv: { type: 'telegram_bot', token: 't-priv' },
      },
      manager_bots: { mgr: { token: 't-mgr' } },
    })
    registry.start()

    await vi.waitFor(() => {
      expect(registry.identities()).toHaveLength(3)
    })
    const byId = new Map(registry.identities().map((identity) => [identity.channelId, identity]))
    expect(byId.get('open')?.canReadAllGroupMessages).toBe(true)
    expect(byId.get('priv')?.canReadAllGroupMessages).toBe(false)
    expect(byId.get('mgr')?.canReadAllGroupMessages).toBeNull()
    registry.stop()
  })

  it('refresh 成功：立即重拉并广播新快照', async () => {
    let privacyOff = false
    stubGetMe(() => me('bot', { can_read_all_group_messages: privacyOff }))
    const { registry, emitted } = makeRegistry({ channels: { tg: { type: 'telegram_bot', token: 't' } } })
    registry.start()
    await vi.waitFor(() => {
      expect(registry.identities()[0]?.canReadAllGroupMessages).toBe(false)
    })

    privacyOff = true
    const emitsBefore = emitted.length
    await expect(registry.refresh('tg')).resolves.toEqual({ ok: true })
    expect(registry.identities()[0]?.canReadAllGroupMessages).toBe(true)
    expect(emitted.length).toBe(emitsBefore + 1)
    registry.stop()
  })

  it('refresh 未知渠道 → ok:false', async () => {
    stubGetMe(() => me('bot'))
    const { registry } = makeRegistry({})
    registry.start()
    await expect(registry.refresh('nope')).resolves.toMatchObject({ ok: false })
    registry.stop()
  })

  it('refresh 失败且已有旧身份 → 保留旧值并返回错误', async () => {
    let broken = false
    stubGetMe(() => {
      if (broken) return new Response(JSON.stringify({ ok: false, error_code: 500, description: 'boom' }))
      return me('bot', { can_read_all_group_messages: false })
    })
    const { registry } = makeRegistry({ channels: { tg: { type: 'telegram_bot', token: 't' } } })
    registry.start()
    await vi.waitFor(() => {
      expect(registry.identities()).toHaveLength(1)
    })

    broken = true
    const result = await registry.refresh('tg')
    expect(result).toMatchObject({ ok: false })
    expect(registry.identities()[0]?.username).toBe('bot')
    registry.stop()
  })

  it('refresh 失败且从未成功过 → 恢复 60s 自动重试', async () => {
    vi.useFakeTimers()
    let calls = 0
    stubGetMe(() => {
      calls += 1
      throw new Error('offline')
    })
    const { registry } = makeRegistry({ channels: { tg: { type: 'telegram_bot', token: 't' } } })
    registry.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    await expect(registry.refresh('tg')).resolves.toMatchObject({ ok: false })
    expect(calls).toBe(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(calls).toBe(3)
    registry.stop()
  })

  it('reconcile：渠道删除后身份消失并广播', async () => {
    stubGetMe(() => me('bot'))
    const { registry, setChannels } = makeRegistry({ channels: { tg: { type: 'telegram_bot', token: 't' } } })
    registry.start()
    await vi.waitFor(() => {
      expect(registry.identities()).toHaveLength(1)
    })

    setChannels({})
    expect(registry.identities()).toHaveLength(0)
    registry.stop()
  })
})
