import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedBotDiscovery } from '../../../shared/messages'
import { ConfigStore } from '../../config/store'
import { AppDatabase } from '../../db/database'
import type { TgManagedBotUpdated } from './bot-api'
import { DiscoveryRepo } from './discovery-repo'
import { ManagedBotRegistry } from './managed-bots'

// registry 单测不 start()（不拉起真实 poller），直接驱动领域方法。
// getManagedBotToken 经 stub fetch 供给。

function stubManagedBotToken(token: string): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockImplementation(async (url: string) => {
    if (String(url).endsWith('/getManagedBotToken')) {
      return new Response(JSON.stringify({ ok: true, result: token }))
    }
    return new Response(JSON.stringify({ ok: false, error_code: 404, description: 'unexpected method' }))
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function makeRegistry() {
  const store = ConfigStore.init(path.join(mkdtempSync(path.join(tmpdir(), 'susie-managed-')), 'config.toml'))
  const repo = new DiscoveryRepo(new AppDatabase(':memory:'))
  const emit = vi.fn<(managerId: string, discoveries: ManagedBotDiscovery[]) => void>()
  const registry = new ManagedBotRegistry({
    store,
    repo,
    emit,
    onMessage: () => {},
    onStatuses: () => {},
    log: { info: () => {}, error: () => {} },
  })
  return { store, repo, emit, registry }
}

const EV: TgManagedBotUpdated = {
  user: { id: 7, is_bot: false, first_name: 'Boss' },
  bot: { id: 999, is_bot: true, first_name: 'Child Bot', username: 'child_bot' },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('handleManagedBotUpdate', () => {
  it('新 bot → 只登记发现并推事件，绝不建渠道', async () => {
    const { store, repo, emit, registry } = makeRegistry()
    store.upsertManagerBot('mgr', { token: '88:t', managing: [] }, store.currentVersion)

    await registry.handleManagedBotUpdate('mgr', '88:t', EV)

    expect(Object.keys(store.current.channels)).toEqual([])
    expect(repo.get('mgr', '999')?.username).toBe('child_bot')
    expect(emit).toHaveBeenCalledTimes(1)
    const list = emit.mock.calls[0]?.[1]
    expect(list?.[0]?.creatorId).toBe('7')
  })

  it('bot 已是渠道（手动 token 添加）→ 记录保留但列表不吐', async () => {
    const { store, repo, registry, emit } = makeRegistry()
    store.upsertManagerBot('mgr', { token: '88:t', managing: [] }, store.currentVersion)
    store.upsertChannel(
      'hand_added',
      { type: 'telegram_bot', token: '999:manual', enabled: true, drop_pending_updates: false },
      store.currentVersion,
    )

    await registry.handleManagedBotUpdate('mgr', '88:t', EV)

    expect(repo.get('mgr', '999')).not.toBeNull()
    expect(emit.mock.calls[0]?.[1]).toEqual([])
    expect(registry.list('mgr')).toEqual([])
  })

  it('已托管渠道（managing 命中）→ token 轮换写回，不产生发现', async () => {
    const { store, repo, registry, emit } = makeRegistry()
    stubManagedBotToken('999:rotated')
    store.upsertManagerBot('mgr', { token: '88:t', managing: ['child_bot'] }, store.currentVersion)
    store.upsertChannel(
      'child_bot',
      { type: 'telegram_bot', token: '999:old', enabled: true, drop_pending_updates: false },
      store.currentVersion,
    )

    await registry.handleManagedBotUpdate('mgr', '88:t', EV)

    expect(store.current.channels['child_bot']?.token).toBe('999:rotated')
    expect(repo.listByManager('mgr')).toEqual([])
    expect(emit).not.toHaveBeenCalled()
  })

  it('token 未变（owner 变更类事件）→ 不写 config', async () => {
    const { store, registry } = makeRegistry()
    stubManagedBotToken('999:same')
    store.upsertManagerBot('mgr', { token: '88:t', managing: ['child_bot'] }, store.currentVersion)
    store.upsertChannel(
      'child_bot',
      { type: 'telegram_bot', token: '999:same', enabled: true, drop_pending_updates: false },
      store.currentVersion,
    )
    const versionBefore = store.currentVersion

    await registry.handleManagedBotUpdate('mgr', '88:t', EV)

    expect(store.currentVersion).toBe(versionBefore)
  })
})

describe('listAddable（存活校验）', () => {
  it('BotFather 已删的 bot（400/403）清库不列出；网络类错误保守保留', async () => {
    const { store, repo, registry } = makeRegistry()
    store.upsertManagerBot('mgr', { token: '88:t', managing: [] }, store.currentVersion)
    await registry.handleManagedBotUpdate('mgr', '88:t', EV)
    await registry.handleManagedBotUpdate('mgr', '88:t', {
      user: EV.user,
      bot: { id: 1000, is_bot: true, first_name: 'Dead', username: 'dead_bot' },
    })

    // bot 999 存活；bot 1000 已在 BotFather 删除 → 400
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { user_id?: number }
        if (body.user_id === 1000) {
          return new Response(JSON.stringify({ ok: false, error_code: 400, description: 'BOT_ACCESS_FORBIDDEN' }))
        }
        return new Response(JSON.stringify({ ok: true, result: '999:alive' }))
      }),
    )

    const alive = await registry.listAddable('mgr')
    expect(alive.map((d) => d.botId)).toEqual(['999'])
    expect(repo.get('mgr', '1000')).toBeNull()
    expect(repo.get('mgr', '999')).not.toBeNull()

    // 401（manager token 问题）不当作已删除
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))),
    )
    const kept = await registry.listAddable('mgr')
    expect(kept.map((d) => d.botId)).toEqual(['999'])
    expect(repo.get('mgr', '999')).not.toBeNull()
  })
})

describe('addManagedBot', () => {
  it('复制 manager 的 owner；成功后移除发现并推事件', async () => {
    const { store, repo, registry, emit } = makeRegistry()
    stubManagedBotToken('999:fresh')
    store.upsertManagerBot('mgr', { token: '88:t', managing: [] }, store.currentVersion)
    store.setUsers(
      [{ channel: 'mgr', user_id: '1', name: 'Owner', role: 'owner', private: 'review', groups: {} }],
      store.currentVersion,
    )
    await registry.handleManagedBotUpdate('mgr', '88:t', EV)
    emit.mockClear()

    const result = await registry.addManagedBot({ managerId: 'mgr', botId: '999', expectedVersion: store.currentVersion })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.channelId).toBe('child_bot')
    expect(store.current.channels['child_bot']?.token).toBe('999:fresh')
    expect(store.current.manager_bots['mgr']?.managing).toEqual(['child_bot'])
    const owner = store.current.users.find((u) => u.channel === 'child_bot' && u.role === 'owner')
    expect(owner?.user_id).toBe('1')
    // 记录保留（渠道删除后凭它重新加回），但已添加的不再出现在列表
    expect(repo.get('mgr', '999')).not.toBeNull()
    expect(registry.list('mgr')).toEqual([])
    expect(emit).toHaveBeenCalledTimes(1)

    // 渠道删除 → 记录重新露出，可再次添加
    store.deleteChannel('child_bot', store.currentVersion)
    expect(registry.list('mgr').map((d) => d.botId)).toEqual(['999'])
  })

  it('manager 未绑定 owner → 兜底用创建者', async () => {
    const { store, registry } = makeRegistry()
    stubManagedBotToken('999:fresh')
    store.upsertManagerBot('mgr', { token: '88:t', managing: [] }, store.currentVersion)
    await registry.handleManagedBotUpdate('mgr', '88:t', EV)

    const result = await registry.addManagedBot({ managerId: 'mgr', botId: '999', expectedVersion: store.currentVersion })

    expect(result.ok).toBe(true)
    const owner = store.current.users.find((u) => u.channel === 'child_bot' && u.role === 'owner')
    expect(owner?.user_id).toBe('7')
    expect(owner?.name).toBe('Boss')
  })

  it('已是渠道 / 发现缺失 / 版本冲突各自拒绝', async () => {
    const { store, registry } = makeRegistry()
    stubManagedBotToken('999:fresh')
    store.upsertManagerBot('mgr', { token: '88:t', managing: [] }, store.currentVersion)

    const missing = await registry.addManagedBot({ managerId: 'mgr', botId: '999', expectedVersion: store.currentVersion })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.message).toContain('发现记录不存在')

    await registry.handleManagedBotUpdate('mgr', '88:t', EV)
    const stale = await registry.addManagedBot({ managerId: 'mgr', botId: '999', expectedVersion: store.currentVersion + 9 })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.conflict).toBe(true)

    store.upsertChannel(
      'occupied',
      { type: 'telegram_bot', token: '999:x', enabled: true, drop_pending_updates: false },
      store.currentVersion,
    )
    const taken = await registry.addManagedBot({ managerId: 'mgr', botId: '999', expectedVersion: store.currentVersion })
    expect(taken.ok).toBe(false)
    if (!taken.ok) expect(taken.message).toContain('已是渠道')
  })
})
