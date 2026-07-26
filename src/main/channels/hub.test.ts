import { describe, expect, it, vi } from 'vitest'
import type { ChannelSettings, Config } from '../../shared/config'
import type { ChannelStatus } from '../../shared/messages'
import type { ConfigStore } from '../config/store'
import { ChannelHub, type ChannelHubDeps } from './hub'
import type { Channel, ChannelFactory } from './types'

// hub 的生命周期编排测试：假工厂 + 假 store，覆盖 spawn/teardown/restart/enabled 开关/statuses。

type ChannelsConfig = Config['channels']

function tgSettings(overrides: Partial<ChannelSettings> = {}): ChannelSettings {
  return { type: 'telegram_bot', token: 't1', enabled: true, drop_pending_updates: false, ...overrides }
}

class FakeChannel implements Channel {
  started = 0
  stopped = 0
  menuRefreshes = 0
  constructor(readonly id: string) {}
  status(): ChannelStatus {
    return { id: this.id, state: 'running', detail: null }
  }
  start(): Promise<void> {
    this.started += 1
    return Promise.resolve()
  }
  stop(): Promise<void> {
    this.stopped += 1
    return Promise.resolve()
  }
  sendMessage = vi.fn()
  editMessage = vi.fn(async () => {})
  answerCallback = vi.fn(async () => {})
  directChatId = (userId: string) => `P:${userId}`
  beginTyping = () => () => {}
  refreshCommandMenus(): Promise<void> {
    this.menuRefreshes += 1
    return Promise.resolve()
  }
}

function makeHarness(initial: ChannelsConfig) {
  let channels = initial
  const listeners: ((next: unknown, prev: unknown) => void)[] = []
  const store = {
    get current() {
      return { channels } as Config
    },
    subscribePath: (_path: string, listener: (next: unknown, prev: unknown) => void) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    ref: (path: string) => ({
      get current() {
        const id = path.split('.')[1] ?? ''
        return channels[id]
      },
      onChange: () => () => {},
    }),
  } as unknown as ConfigStore

  const created: FakeChannel[] = []
  const factory: ChannelFactory = {
    type: 'telegram_bot',
    create: (id) => {
      const channel = new FakeChannel(id)
      created.push(channel)
      return channel
    },
    restartRequired: (prev, next) => prev.token !== next.token,
  }

  const removed: string[] = []
  const statusPushes: ChannelStatus[][] = []
  const errors: string[] = []
  const deps: ChannelHubDeps = {
    store,
    factories: new Map([[factory.type, factory]]),
    attachmentsDir: '/tmp/att',
    listCommands: () => [],
    listPrivilegedUserIds: () => [],
    onMessage: () => {},
    onCallback: () => {},
    onStatuses: (statuses) => statusPushes.push(statuses),
    onChannelRemoved: (id) => removed.push(id),
    log: { info: () => {}, error: (message) => errors.push(message) },
  }
  const hub = new ChannelHub(deps)

  const applyConfig = (next: ChannelsConfig) => {
    const prev = channels
    channels = next
    for (const listener of listeners) listener(next, prev)
  }

  return { hub, created, removed, statusPushes, errors, applyConfig }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('ChannelHub', () => {
  it('start：启动 enabled 通道，跳过 disabled；statuses 覆盖全部配置项', () => {
    const { hub, created } = makeHarness({
      a: tgSettings(),
      b: tgSettings({ enabled: false }),
    })
    hub.start()

    expect(created.map((c) => c.id)).toEqual(['a'])
    expect(created[0]?.started).toBe(1)

    const statuses = hub.statuses()
    expect(statuses).toEqual([
      { id: 'a', state: 'running', detail: null },
      { id: 'b', state: 'stopped', detail: '已禁用' },
    ])
  })

  it('配置删除 → 停机并通知 onChannelRemoved；enabled=false → 停机不通知', async () => {
    const { hub, created, removed, applyConfig } = makeHarness({ a: tgSettings(), b: tgSettings({ token: 't2' }) })
    hub.start()

    applyConfig({ b: tgSettings({ token: 't2', enabled: false }) }) // a 删除、b 禁用
    await flush()

    expect(created.find((c) => c.id === 'a')?.stopped).toBe(1)
    expect(created.find((c) => c.id === 'b')?.stopped).toBe(1)
    expect(removed).toEqual(['a']) // 仅真删除通知
  })

  it('restart-required 字段变更 → 重启（新实例）；无关字段变更 → 原实例保持', async () => {
    const { hub, created, applyConfig } = makeHarness({ a: tgSettings() })
    hub.start()
    expect(created).toHaveLength(1)

    // 无关字段（drop_pending_updates 不在假工厂的 restart 判定里）
    applyConfig({ a: tgSettings({ drop_pending_updates: true }) })
    await flush()
    expect(created).toHaveLength(1)
    expect(created[0]?.stopped).toBe(0)

    // token 变更 → teardown + spawn
    applyConfig({ a: tgSettings({ token: 't9' }) })
    await flush()
    expect(created).toHaveLength(2)
    expect(created[0]?.stopped).toBe(1)
    expect(created[1]?.started).toBe(1)
  })

  it('未注册的通道类型：报错不崩溃', () => {
    const { hub, created, errors } = makeHarness({
      a: { type: 'slack', token: 'x', enabled: true } as unknown as ChannelSettings,
    })
    hub.start()

    expect(created).toHaveLength(0)
    expect(errors.some((line) => line.includes('未注册的通道类型'))).toBe(true)
  })

  it('stopAll：全部停机且不再响应配置变更', async () => {
    const { hub, created, applyConfig } = makeHarness({ a: tgSettings() })
    hub.start()

    await hub.stopAll()
    expect(created[0]?.stopped).toBe(1)

    applyConfig({ a: tgSettings({ token: 'tz' }) })
    await flush()
    // stopAll 之后订阅已退：不 spawn 新实例
    expect(created).toHaveLength(1)
  })

  it('refreshCommandMenus 广播到全部运行中通道', () => {
    const { hub, created } = makeHarness({ a: tgSettings(), b: tgSettings({ token: 't2' }) })
    hub.start()

    hub.refreshCommandMenus()
    expect(created.map((c) => c.menuRefreshes)).toEqual([1, 1])
  })
})
