import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TelegramBotChannelSettings } from '../../shared/config'
import { ConfigStore } from './store'

function tempConfigPath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'susie-config-')), 'config.toml')
}

const LEGACY_TOML = `
api_id = 123
api_hash = "abc"

[channels.legacy_user]
type = "telegram_user"
session_name = "s"

[channels.bot]
type = "telegram_bot"
token = "123:token"
whitelist = ["1"]

[channels.bot.groups."*"]
whitelist = ["*"]
only_mention = true

[[assistants]]
id = "default"
agent_id = "codex"

[[bindings]]
channel = "bot"
assistant_id = "default"
chat_ids = ["*"]
`

describe('ConfigStore.init', () => {
  it('creates a default config file when missing', () => {
    const configPath = tempConfigPath()
    const store = ConfigStore.init(configPath)

    expect(existsSync(configPath)).toBe(true)
    expect(store.state().lastError).toBeNull()
    expect(store.current.assistants.map((a) => a.id)).toContain('default')
  })

  it('ignores legacy content in memory without rewriting the file', () => {
    const configPath = tempConfigPath()
    writeFileSync(configPath, LEGACY_TOML)

    const store = ConfigStore.init(configPath)
    const state = store.state()

    expect(state.lastError).toBeNull()
    expect(Object.keys(state.config.channels)).toEqual(['bot'])
    expect(state.migrations).toHaveLength(5) // api_id + api_hash + telegram_user 通道 + 准入字段剥离 + chat_ids 展开
    // 文件本身保持原样
    expect(readFileSync(configPath, 'utf-8')).toBe(LEGACY_TOML)
  })
})

describe('hot reload', () => {
  it('applies external changes and notifies only affected paths', () => {
    const configPath = tempConfigPath()
    writeFileSync(configPath, LEGACY_TOML)
    const store = ConfigStore.init(configPath)

    const botEvents: unknown[] = []
    const assistantEvents: unknown[] = []
    store.ref<TelegramBotChannelSettings>('channels.bot').onChange((next) => botEvents.push(next))
    store.ref('assistants.default').onChange((next) => assistantEvents.push(next))

    const versionBefore = store.currentVersion
    store.applyExternalText(LEGACY_TOML.replace('123:token', '123:token-b'))

    expect(store.currentVersion).toBe(versionBefore + 1)
    expect(botEvents).toHaveLength(1)
    expect((botEvents[0] as TelegramBotChannelSettings).token).toBe('123:token-b')
    expect(assistantEvents).toHaveLength(0)
  })

  it('keeps last-good config when the new text is invalid, then recovers', () => {
    const configPath = tempConfigPath()
    writeFileSync(configPath, LEGACY_TOML)
    const store = ConfigStore.init(configPath)
    const versionBefore = store.currentVersion

    store.applyExternalText('%%% not toml')
    expect(store.state().lastError).toContain('TOML')
    expect(store.currentVersion).toBe(versionBefore)
    expect(Object.keys(store.current.channels)).toEqual(['bot'])

    store.applyExternalText(LEGACY_TOML)
    expect(store.state().lastError).toBeNull()
  })

  it('resolves refs to undefined after the entity is removed', () => {
    const configPath = tempConfigPath()
    writeFileSync(configPath, LEGACY_TOML)
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
        { channel: 'b', chat_id: 'P:1', assistant_id: 'default', only_mention: true, members: [], send_output: false },
        { channel: 'b', chat_id: '*', assistant_id: 'default', only_mention: true, members: [], send_output: false },
      ],
      versionBefore,
    )
    expect(replaced.ok).toBe(true)
    expect(store.current.bindings.map((b) => b.channel)).toEqual(['b', 'b'])
    expect(store.currentVersion).toBe(versionBefore + 1)
    expect(readFileSync(configPath, 'utf-8')).toContain('[[bindings]]')

    // 引用未知 assistant → superRefine 拒绝，状态不变
    const invalid = store.setBindings(
      [{ channel: 'b', chat_id: '*', assistant_id: 'ghost', only_mention: true, members: [], send_output: false }],
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

  it('replaces users wholesale and persists the section to disk', () => {
    const configPath = tempConfigPath()
    const store = ConfigStore.init(configPath)

    const events: unknown[] = []
    store.subscribePath('users', (next) => events.push(next))

    const result = store.setUsers(
      [
        { channel: 'bot', user_id: '1', name: 'Alice', role: 'owner' },
        { channel: 'bot', user_id: '2', role: 'member' },
      ],
      store.currentVersion,
    )
    expect(result.ok).toBe(true)
    expect(events).toHaveLength(1)
    const text = readFileSync(configPath, 'utf-8')
    expect(text).toContain('[[users]]')
    expect(text).toContain('role = "owner"')

    // 重新加载：users 段完整往返
    const reloaded = ConfigStore.init(configPath)
    expect(reloaded.current.users).toHaveLength(2)
    expect(reloaded.current.users[0]?.role).toBe('owner')
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
        { channel: 'bot', user_id: '1', role: 'member' },
        { channel: 'bot', user_id: '1', role: 'admin' },
      ],
      store.currentVersion,
    )
    expect(dup.ok).toBe(false)
    if (!dup.ok) expect(dup.message).toContain('重复登记')

    const twoOwners = store.setUsers(
      [
        { channel: 'bot', user_id: '1', role: 'owner' },
        { channel: 'bot', user_id: '2', role: 'owner' },
      ],
      store.currentVersion,
    )
    expect(twoOwners.ok).toBe(false)
    if (!twoOwners.ok) expect(twoOwners.message).toContain('owner')

    // 不同频道各自一个 owner 合法
    const ok = store.setUsers(
      [
        { channel: 'a', user_id: '1', role: 'owner' },
        { channel: 'b', user_id: '1', role: 'owner' },
      ],
      store.currentVersion,
    )
    expect(ok.ok).toBe(true)
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
})
