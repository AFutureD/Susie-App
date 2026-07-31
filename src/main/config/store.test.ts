import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TelegramBotChannelSettings } from '../../shared/config'
import { ConfigStore } from './store'

function tempConfigPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'susie-config-')), 'config.toml')
}

const BASE_TOML = `
[channels.bot]
type = "telegram_bot"
token = "123:token"

[[assistants]]
id = "default"
agent_id = "codex"

[[bindings]]
channel = "bot"
assistant_id = "default"
`

describe('ConfigStore.init', () => {
  it('creates a default config file when missing, and flags firstRun', () => {
    const configPath = tempConfigPath()
    const store = ConfigStore.init(configPath)

    expect(existsSync(configPath)).toBe(true)
    expect(store.state().lastError).toBeNull()
    expect(store.state().firstRun).toBe(true)
    expect(store.current.assistants.map((a) => a.id)).toContain('default')

    // 缺失事实在写入默认文件前采样：同一路径再 init 就不再是首启
    expect(ConfigStore.init(configPath).state().firstRun).toBe(false)
  })

  it('rejects legacy Python-era configs outright (no compatibility): default + lastError', () => {
    const configPath = tempConfigPath()
    writeFileSync(
      configPath,
      `
api_id = 123

[channels.bot]
type = "telegram_bot"
token = "123:token"
whitelist = ["1"]
`,
    )
    const store = ConfigStore.init(configPath)
    expect(store.state().lastError).toContain('配置校验失败')
    expect(store.state().firstRun).toBe(false)
    // 退化为内存默认配置；文件保持原样
    expect(Object.keys(store.current.channels)).toEqual([])
    expect(readFileSync(configPath, 'utf-8')).toContain('api_id')
  })
})

describe('hot reload', () => {
  it('applies external changes and notifies only affected paths', () => {
    const configPath = tempConfigPath()
    writeFileSync(configPath, BASE_TOML)
    const store = ConfigStore.init(configPath)

    const botEvents: unknown[] = []
    const assistantEvents: unknown[] = []
    store.ref<TelegramBotChannelSettings>('channels.bot').onChange((next) => botEvents.push(next))
    store.ref('assistants.default').onChange((next) => assistantEvents.push(next))

    const versionBefore = store.currentVersion
    store.applyExternalText(BASE_TOML.replace('123:token', '123:token-b'))

    expect(store.currentVersion).toBe(versionBefore + 1)
    expect(botEvents).toHaveLength(1)
    expect((botEvents[0] as TelegramBotChannelSettings).token).toBe('123:token-b')
    expect(assistantEvents).toHaveLength(0)
  })

  it('keeps last-good config when the new text is invalid, then recovers', () => {
    const configPath = tempConfigPath()
    writeFileSync(configPath, BASE_TOML)
    const store = ConfigStore.init(configPath)
    const versionBefore = store.currentVersion

    store.applyExternalText('%%% not toml')
    expect(store.state().lastError).toContain('TOML')
    expect(store.currentVersion).toBe(versionBefore)
    expect(Object.keys(store.current.channels)).toEqual(['bot'])

    store.applyExternalText(BASE_TOML)
    expect(store.state().lastError).toBeNull()
  })

  it('resolves refs to undefined after the entity is removed', () => {
    const configPath = tempConfigPath()
    writeFileSync(configPath, BASE_TOML)
    const store = ConfigStore.init(configPath)

    const ref = store.ref<TelegramBotChannelSettings>('channels.bot')
    expect(ref.current?.token).toBe('123:token')

    const events: [unknown, unknown][] = []
    ref.onChange((next, prev) => events.push([next, prev]))

    const withoutBot = `
[[assistants]]
id = "default"
agent_id = "codex"
`
    store.applyExternalText(withoutBot)

    expect(ref.current).toBeUndefined()
    expect(events).toHaveLength(1)
    const [next, prev] = events[0] ?? []
    expect(next).toBeUndefined()
    expect((prev as TelegramBotChannelSettings).token).toBe('123:token')
  })

  it('suppresses watcher echo of its own writes', () => {
    const configPath = tempConfigPath()
    const store = ConfigStore.init(configPath)

    const settings: TelegramBotChannelSettings = {
      type: 'telegram_bot',
      token: 't:1',
      enabled: true,
      drop_pending_updates: false,
    }
    expect(store.upsertChannel('bot', settings, store.currentVersion).ok).toBe(true)

    let stateNotifications = 0
    store.onState(() => {
      stateNotifications += 1
    })
    store.reloadFromDisk() // watcher 对自写文件的回调
    expect(stateNotifications).toBe(0)
  })
})

describe('mutations', () => {
  it('upserts a channel, bumps version and persists to disk', () => {
    const configPath = tempConfigPath()
    const store = ConfigStore.init(configPath)
    const versionBefore = store.currentVersion

    const settings: TelegramBotChannelSettings = {
      type: 'telegram_bot',
      token: '999:secret',
      enabled: true,
      drop_pending_updates: false,
    }
    const result = store.upsertChannel('mybot', settings, versionBefore)

    expect(result.ok).toBe(true)
    expect(store.currentVersion).toBe(versionBefore + 1)
    const text = readFileSync(configPath, 'utf-8')
    expect(text).toContain('[channels.mybot]')
    expect(text).toContain('999:secret')
  })

  it('rejects stale expectedVersion with a conflict', () => {
    const store = ConfigStore.init(tempConfigPath())
    const result = store.upsertChannel(
      'bot',
      { type: 'telegram_bot', token: 't', enabled: true, drop_pending_updates: false },
      store.currentVersion + 5,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflict).toBe(true)
  })

  it('deletes unreferenced assistants but refuses ones referenced by bindings', () => {
    const configPath = tempConfigPath()
    writeFileSync(
      configPath,
      `
[[assistants]]
id = "default"

[[assistants]]
id = "ops"

[[bindings]]
channel = "bot"
assistant_id = "ops"
`,
    )
    const store = ConfigStore.init(configPath)

    // 不再有全局兜底特权助手：未被引用即可删除
    expect(store.deleteAssistant('default', store.currentVersion).ok).toBe(true)

    const result = store.deleteAssistant('ops', store.currentVersion)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('ops')
  })

  it('replaces bindings wholesale, rejects unknown assistants and stale versions', () => {
    const configPath = tempConfigPath()
    writeFileSync(
      configPath,
      `
[[assistants]]
id = "default"

[[bindings]]
channel = "a"
assistant_id = "default"
`,
    )
    const store = ConfigStore.init(configPath)

    const versionBefore = store.currentVersion
    const replaced = store.setBindings(
      [
        { channel: 'b', chat_id: 'P:1', assistant_id: 'default', only_mention: true, send_output: false },
        { channel: 'b', chat_id: '*', assistant_id: 'default', only_mention: true, send_output: false },
      ],
      versionBefore,
    )
    expect(replaced.ok).toBe(true)
    expect(store.current.bindings.map((b) => b.channel)).toEqual(['b', 'b'])
    expect(store.currentVersion).toBe(versionBefore + 1)
    expect(readFileSync(configPath, 'utf-8')).toContain('[[bindings]]')

    // 引用未知 assistant → superRefine 拒绝，状态不变
    const invalid = store.setBindings(
      [{ channel: 'b', chat_id: '*', assistant_id: 'ghost', only_mention: true, send_output: false }],
      store.currentVersion,
    )
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.message).toContain('ghost')
    expect(store.current.bindings.map((b) => b.assistant_id)).toEqual(['default', 'default'])

    // stale version → conflict
    const stale = store.setBindings([], versionBefore)
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.conflict).toBe(true)
  })

  it('replaces users wholesale and persists scope permissions to disk', () => {
    const configPath = tempConfigPath()
    const store = ConfigStore.init(configPath)

    const events: unknown[] = []
    store.subscribePath('users', (next) => events.push(next))

    const result = store.setUsers(
      [
        { channel: 'bot', user_id: '1', name: 'Alice', role: 'owner', private: 'review', groups: {} },
        { channel: 'bot', user_id: '2', role: 'user', private: 'allow', groups: { 'S:-100': 'ignore' } },
      ],
      store.currentVersion,
    )
    expect(result.ok).toBe(true)
    expect(events).toHaveLength(1)
    const text = readFileSync(configPath, 'utf-8')
    expect(text).toContain('[[users]]')
    expect(text).toContain('role = "owner"')
    expect(text).toContain('private = "allow"')

    // 重新加载：users 段（含群档位）完整往返
    const reloaded = ConfigStore.init(configPath)
    expect(reloaded.current.users).toHaveLength(2)
    expect(reloaded.current.users[0]?.role).toBe('owner')
    expect(reloaded.current.users[1]?.groups['S:-100']).toBe('ignore')
  })

  it('parses configs without a users section as an empty roster', () => {
    const configPath = tempConfigPath()
    writeFileSync(configPath, '[[assistants]]\nid = "default"\n')
    const store = ConfigStore.init(configPath)
    expect(store.state().lastError).toBeNull()
    expect(store.current.users).toEqual([])
  })

  it('rejects duplicate users and a second owner per channel', () => {
    const store = ConfigStore.init(tempConfigPath())

    const dup = store.setUsers(
      [
        { channel: 'bot', user_id: '1', role: 'user', private: 'review', groups: {} },
        { channel: 'bot', user_id: '1', role: 'user', private: 'allow', groups: {} },
      ],
      store.currentVersion,
    )
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.message).toContain('重复登记')

    const twoOwners = store.setUsers(
      [
        { channel: 'bot', user_id: '1', role: 'owner', private: 'review', groups: {} },
        { channel: 'bot', user_id: '2', role: 'owner', private: 'review', groups: {} },
      ],
      store.currentVersion,
    )
    expect(twoOwners.ok).toBe(false)
    if (!twoOwners.ok) expect(twoOwners.message).toContain('owner')

    // 不同频道各自一个 owner 合法
    const ok = store.setUsers(
      [
        { channel: 'a', user_id: '1', role: 'owner', private: 'review', groups: {} },
        { channel: 'b', user_id: '1', role: 'owner', private: 'review', groups: {} },
      ],
      store.currentVersion,
    )
    expect(ok.ok).toBe(true)
  })

  it('rejects configs with removed fields (no migration): last-good stays active', () => {
    const configPath = tempConfigPath()
    writeFileSync(
      configPath,
      `
[[assistants]]
id = "default"

[[bindings]]
channel = "bot"
assistant_id = "default"
members = ["7"]
`,
    )
    const store = ConfigStore.init(configPath)
    // strictObject 拒绝已删除的 members 字段 → 退化为默认配置 + lastError
    expect(store.state().lastError).toContain('members')
  })

  it('rejects invalid raw text without touching state', () => {
    const store = ConfigStore.init(tempConfigPath())
    const versionBefore = store.currentVersion

    const bad = store.saveRaw('channels = 1', versionBefore)
    expect(bad.ok).toBe(false)
    expect(store.currentVersion).toBe(versionBefore)
    expect(store.state().lastError).toBeNull()

    const good = store.saveRaw('[[assistants]]\nid = "default"\n', versionBefore)
    expect(good.ok).toBe(true)
  })

  it('manager_bots：TOML 完整往返，path 订阅与寻址可用', () => {
    const configPath = tempConfigPath()
    const store = ConfigStore.init(configPath)

    const events: unknown[] = []
    store.ref('manager_bots.mgr').onChange((next) => events.push(next))

    const result = store.upsertManagerBot('mgr', { token: '88:mgr-token', managing: [] }, store.currentVersion)
    expect(result.ok).toBe(true)
    expect(events).toHaveLength(1)
    const text = readFileSync(configPath, 'utf-8')
    expect(text).toContain('[manager_bots.mgr]')
    expect(text).toContain('88:mgr-token')

    const reloaded = ConfigStore.init(configPath)
    expect(reloaded.state().lastError).toBeNull()
    expect(reloaded.current.manager_bots['mgr']?.managing).toEqual([])
  })

  it('addManagedChannel：渠道 + managing + owner 一次原子写入；重复 id 与未知 manager 拒绝', () => {
    const configPath = tempConfigPath()
    const store = ConfigStore.init(configPath)
    store.upsertManagerBot('mgr', { token: '88:t', managing: [] }, store.currentVersion)
    store.setUsers([{ channel: 'mgr', user_id: '7', name: 'Boss', role: 'owner', private: 'review', groups: {} }], store.currentVersion)

    const settings = { type: 'telegram_bot', token: '99:child', enabled: true, drop_pending_updates: false } as const
    const added = store.addManagedChannel(
      { managerId: 'mgr', channelId: 'child_bot', settings, owner: { userId: '7', name: 'Boss' } },
      store.currentVersion,
    )
    expect(added.ok).toBe(true)
    expect(store.current.manager_bots['mgr']?.managing).toEqual(['child_bot'])
    expect(store.current.users.find((u) => u.channel === 'child_bot')?.role).toBe('owner')

    const dup = store.addManagedChannel(
      { managerId: 'mgr', channelId: 'child_bot', settings, owner: { userId: '7' } },
      store.currentVersion,
    )
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.message).toContain('已存在')

    const ghost = store.addManagedChannel(
      { managerId: 'nope', channelId: 'other_bot', settings, owner: { userId: '7' } },
      store.currentVersion,
    )
    expect(ghost.ok).toBe(false)
    if (!ghost.ok) expect(ghost.message).toContain('manager 不存在')
  })

  it('deleteChannel 会同步从 manager.managing 剔除；deleteManagerBot 保留 managed 渠道', () => {
    const configPath = tempConfigPath()
    const store = ConfigStore.init(configPath)
    store.upsertManagerBot('mgr', { token: '88:t', managing: [] }, store.currentVersion)
    const settings = { type: 'telegram_bot', token: '99:child', enabled: true, drop_pending_updates: false } as const
    store.addManagedChannel(
      { managerId: 'mgr', channelId: 'child_bot', settings, owner: { userId: '7' } },
      store.currentVersion,
    )

    expect(store.deleteChannel('child_bot', store.currentVersion).ok).toBe(true)
    expect(store.current.manager_bots['mgr']?.managing).toEqual([])

    store.addManagedChannel(
      { managerId: 'mgr', channelId: 'child_bot', settings, owner: { userId: '7' } },
      store.currentVersion,
    )
    expect(store.deleteManagerBot('mgr', store.currentVersion).ok).toBe(true)
    expect(store.current.manager_bots['mgr']).toBeUndefined()
    expect(store.current.channels['child_bot']).toBeDefined()
  })

  it('scheduled task：设 skill 时空 content 合法（补充输入可空），未设时拒绝；skill 完整往返', () => {
    const configPath = tempConfigPath()
    writeFileSync(configPath, '[[assistants]]\nid = "default"\n')
    const store = ConfigStore.init(configPath)

    const base = {
      id: 't1',
      name: '技能任务',
      content: '',
      assistant_id: 'default',
      schedule: '0 9 * * *',
      targets: [{ channel: 'bot', chat_id: 'P:1' }],
      enabled: true,
    }

    const rejected = store.upsertScheduledTask(base, store.currentVersion)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.message).toContain('任务内容不能为空')

    const withSkill = store.upsertScheduledTask({ ...base, skill: 'daily' }, store.currentVersion)
    expect(withSkill.ok).toBe(true)
    const text = readFileSync(configPath, 'utf-8')
    expect(text).toContain('[[scheduled_tasks]]')
    expect(text).toContain('skill = "daily"')

    const reloaded = ConfigStore.init(configPath)
    expect(reloaded.state().lastError).toBeNull()
    expect(reloaded.current.scheduled_tasks[0]?.skill).toBe('daily')
  })
})
