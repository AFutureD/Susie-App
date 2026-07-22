import { describe, expect, it } from 'vitest'
import type { TelegramBotChannelSettings } from '../../shared/config'
import { decodeChatId, encodeChatId } from './chat-id'
import { isInboundAllowed } from './telegram-policy'
import { escapeHtml, renderMessageHtml, renderMessagePlain } from './telegram-render'

function settings(overrides: Partial<TelegramBotChannelSettings> = {}): TelegramBotChannelSettings {
  return {
    type: 'telegram_bot',
    token: 't',
    enabled: true,
    whitelist: [],
    groups: {},
    drop_pending_updates: false,
    ...overrides,
  }
}

describe('chat-id codec', () => {
  it('round-trips all chat kinds', () => {
    for (const kind of ['private', 'group', 'supergroup', 'channel', 'sender']) {
      const encoded = encodeChatId(kind, -100123, null)
      const decoded = decodeChatId(encoded)
      expect(decoded).toEqual({ chatType: kind, rawChatId: -100123, threadId: null })
    }
  })

  it('encodes forum threads and rejects garbage', () => {
    expect(encodeChatId('supergroup', -1, 42)).toBe('S:-1:42')
    expect(decodeChatId('S:-1:42')).toEqual({ chatType: 'supergroup', rawChatId: -1, threadId: 42 })
    expect(decodeChatId('??')).toBeNull()
    expect(decodeChatId('Z:1')).toBeNull()
    expect(decodeChatId('P:abc')).toBeNull()
    expect(encodeChatId('unknown', 1)).toBe('')
  })
})

describe('inbound policy', () => {
  it('denies bots and missing users', () => {
    const s = settings({ whitelist: ['*'] })
    expect(
      isInboundAllowed(s, { fromBot: true, userId: '1', chatType: 'private', rawChatId: '1', mentioned: false }),
    ).toBe(false)
    expect(
      isInboundAllowed(s, { fromBot: false, userId: null, chatType: 'private', rawChatId: '1', mentioned: false }),
    ).toBe(false)
  })

  it('private chats use the channel whitelist', () => {
    const s = settings({ whitelist: ['42'] })
    expect(
      isInboundAllowed(s, { fromBot: false, userId: '42', chatType: 'private', rawChatId: '42', mentioned: false }),
    ).toBe(true)
    expect(
      isInboundAllowed(s, { fromBot: false, userId: '7', chatType: 'private', rawChatId: '7', mentioned: false }),
    ).toBe(false)
  })

  it('groups fall back to the "*" policy and honor only_mention', () => {
    const s = settings({
      groups: {
        '*': { whitelist: ['*'], only_mention: true },
        '-100': { whitelist: ['9'], only_mention: false },
      },
    })
    // 特定群策略优先
    expect(
      isInboundAllowed(s, { fromBot: false, userId: '9', chatType: 'supergroup', rawChatId: '-100', mentioned: false }),
    ).toBe(true)
    expect(
      isInboundAllowed(s, { fromBot: false, userId: '8', chatType: 'supergroup', rawChatId: '-100', mentioned: false }),
    ).toBe(false)
    // 其他群回退 * 策略：需要 @ 提及
    expect(
      isInboundAllowed(s, { fromBot: false, userId: '1', chatType: 'group', rawChatId: '-200', mentioned: false }),
    ).toBe(false)
    expect(
      isInboundAllowed(s, { fromBot: false, userId: '1', chatType: 'group', rawChatId: '-200', mentioned: true }),
    ).toBe(true)
  })

  it('denies groups when no policy matches', () => {
    expect(
      isInboundAllowed(settings(), {
        fromBot: false,
        userId: '1',
        chatType: 'group',
        rawChatId: '-1',
        mentioned: true,
      }),
    ).toBe(false)
  })
})

describe('outbound rendering', () => {
  it('escapes html and renders expandable quotes', () => {
    expect(escapeHtml('<a & b>')).toBe('&lt;a &amp; b&gt;')
    const html = renderMessageHtml([
      { kind: 'text', text: 'hi <you>' },
      { kind: 'quote', title: '[completed] ls -la', body: 'total <0>' },
      { kind: 'file', path: '/tmp/x.png' },
    ])
    expect(html).toContain('hi &lt;you&gt;')
    expect(html).toContain('<blockquote expandable><b>[completed] ls -la</b>\ntotal &lt;0&gt;</blockquote>')
    expect(html).not.toContain('/tmp/x.png')
  })

  it('renders a plain-text fallback', () => {
    const plain = renderMessagePlain([
      { kind: 'text', text: 'a' },
      { kind: 'quote', title: 't', body: 'b' },
    ])
    expect(plain).toBe('a\n\n[t]\nb')
  })
})
