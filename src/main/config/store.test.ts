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
    expect(state.migrations).toHaveLength(3) // api_id + api_hash + telegram_user 通道
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
    store.applyExternalText(LEGACY_TOML.replace('whitelist = ["1"]', 'whitelist = ["1", "2"]'))

    expect(store.currentVersion).toBe(versionBefore + 1)
    expect(botEvents).toHaveLength(1)
    expect((botEvents[0] as TelegramBotChannelSettings).whitelist).toEqual(['1', '2'])
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
      whitelist: [],
      groups: {},
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
      whitelist: ['42'],
      groups: { '*': { whitelist: ['*'], only_mention: true } },
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
      { type: 'telegram_bot', token: 't', enabled: true, whitelist: [], groups: {}, drop_pending_updates: false },
      store.currentVersion + 5,
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.conflict).toBe(true)
  })

  it('refuses to delete the default assistant or one referenced by bindings', () => {
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

    expect(store.deleteAssistant('default', store.currentVersion).ok).toBe(false)

    const result = store.deleteAssistant('ops', store.currentVersion)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('ops')
  })

  it('moves a binding up/down and rejects out-of-range moves', () => {
    const configPath = tempConfigPath()
    writeFileSync(
      configPath,
      `
[[assistants]]
id = "default"

[[bindings]]
channel = "a"
assistant_id = "default"

[[bindings]]
channel = "b"
assistant_id = "default"
`,
    )
    const store = ConfigStore.init(configPath)

    expect(store.moveBinding(1, 'up', store.currentVersion).ok).toBe(true)
    expect(store.current.bindings.map((b) => b.channel)).toEqual(['b', 'a'])

    expect(store.moveBinding(0, 'down', store.currentVersion).ok).toBe(true)
    expect(store.current.bindings.map((b) => b.channel)).toEqual(['a', 'b'])

    const versionBefore = store.currentVersion
    expect(store.moveBinding(0, 'up', versionBefore).ok).toBe(false)
    expect(store.moveBinding(1, 'down', versionBefore).ok).toBe(false)
    expect(store.currentVersion).toBe(versionBefore)
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
