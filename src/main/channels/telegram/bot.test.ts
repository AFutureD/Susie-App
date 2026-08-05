import { EventEmitter } from 'node:events'
import type TelegramBot from 'node-telegram-bot-api'
import { TelegramError } from 'node-telegram-bot-api'
import { describe, expect, it, vi } from 'vitest'
import { decodeChatId, encodeChatId } from '../../../shared/chat-id'
import type { TelegramBotChannelSettings } from '../../../shared/config'
import type { ConfigRef } from '../../config/store'
import { TelegramBotChannel, isHtmlEntityError, toBotCommands, toInlineKeyboard } from './bot'
import { markdownToTelegramHtml } from './markdown'
import { escapeHtml, renderMessageHtml, renderMessagePlain } from './render'

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

describe('toBotCommands', () => {
  it('keeps valid names and maps to BotCommand shape', () => {
    expect(toBotCommands([{ name: 'new', description: '开启新会话' }])).toEqual([
      { command: 'new', description: '开启新会话' },
    ])
  })

  it('drops names outside the [a-z0-9_]{1,32} rule', () => {
    const specs = [
      { name: 'Help', description: 'upper' },
      { name: 'a.b', description: 'dot' },
      { name: 'x'.repeat(33), description: 'too long' },
      { name: 'chat_id', description: 'ok' },
    ]
    expect(toBotCommands(specs).map((c) => c.command)).toEqual(['chat_id'])
  })

  it('clamps descriptions to 256 chars and falls back to the name when empty', () => {
    const [long, empty] = toBotCommands([
      { name: 'long', description: 'd'.repeat(300) },
      { name: 'empty', description: '' },
    ])
    expect(long!.description).toHaveLength(256)
    expect(empty!.description).toBe('empty')
  })
})

describe('toInlineKeyboard', () => {
  it('maps button rows to the Bot API inline keyboard shape', () => {
    expect(
      toInlineKeyboard([
        [
          { id: 'apv:1:allow', label: '允许' },
          { id: 'apv:1:deny', label: '拒绝' },
        ],
        [{ id: 'x', label: 'X' }],
      ]),
    ).toEqual({
      inline_keyboard: [
        [
          { text: '允许', callback_data: 'apv:1:allow' },
          { text: '拒绝', callback_data: 'apv:1:deny' },
        ],
        [{ text: 'X', callback_data: 'x' }],
      ],
    })
    expect(toInlineKeyboard([])).toEqual({ inline_keyboard: [] })
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

  it('renders markdown text parts as telegram html', () => {
    const html = renderMessageHtml([{ kind: 'text', text: '**bold** and `a < b`' }])
    expect(html).toBe('<b>bold</b> and <code>a &lt; b</code>')
  })

  it('renders a plain-text fallback', () => {
    const plain = renderMessagePlain([
      { kind: 'text', text: 'a' },
      { kind: 'quote', title: 't', body: 'b' },
    ])
    expect(plain).toBe('a\n\n[t]\nb')
  })
})

describe('isHtmlEntityError (HTML → 纯文本重试白名单)', () => {
  // 白名单：Telegram 明确的 entity/parser 错误才允许降级为纯文本
  it.each([
    "Bad Request: can't parse entities: Unexpected end tag",
    'Bad Request: unsupported start tag "foo"',
    'Bad Request: can\'t find end tag corresponding to start tag "b"',
    "CAN'T PARSE ENTITIES", // 大小写不敏感
  ])('降级重试：%s', (message) => {
    expect(isHtmlEntityError(new Error(message))).toBe(true)
  })

  // 黑名单：Topic、权限、未知错误一律直接失败（绝不静默降级）
  it.each([
    'Bad Request: message thread not found',
    'Bad Request: TOPIC_CLOSED',
    'Forbidden: bot was blocked by the user',
    'Bad Request: chat write forbidden',
    'ECONNRESET',
  ])('直接失败：%s', (message) => {
    expect(isHtmlEntityError(new Error(message))).toBe(false)
  })

  it('non-Error 值也能安全归为不降级', () => {
    expect(isHtmlEntityError('some string')).toBe(false)
    expect(isHtmlEntityError(undefined)).toBe(false)
    expect(isHtmlEntityError({ message: "can't parse entities" })).toBe(false)
  })
})

describe('markdown → telegram html', () => {
  it('converts inline styles', () => {
    expect(markdownToTelegramHtml('**b** *i* _i_ ~~s~~ __b__ ||sp|| ***bi***')).toBe(
      '<b>b</b> <i>i</i> <i>i</i> <s>s</s> <b>b</b> <tg-spoiler>sp</tg-spoiler> <b><i>bi</i></b>',
    )
  })

  it('nests inline styles without breaking tag order', () => {
    expect(markdownToTelegramHtml('*a **b** c*')).toBe('<i>a <b>b</b> c</i>')
  })

  it('leaves snake_case, bare stars and math untouched', () => {
    expect(markdownToTelegramHtml('foo_bar_baz 2 * 3 * 4 a*b')).toBe('foo_bar_baz 2 * 3 * 4 a*b')
  })

  it('converts links and autolinks, protecting urls from italics', () => {
    expect(markdownToTelegramHtml('[x](https://e.co/a_b_c)')).toBe('<a href="https://e.co/a_b_c">x</a>')
    expect(markdownToTelegramHtml('<https://e.co/?a=1&b=2>')).toBe(
      '<a href="https://e.co/?a=1&amp;b=2">https://e.co/?a=1&amp;b=2</a>',
    )
  })

  it('escapes html inside inline code and keeps markdown literal there', () => {
    expect(markdownToTelegramHtml('run `rm <a> && *x*` now')).toBe('run <code>rm &lt;a&gt; &amp;&amp; *x*</code> now')
  })

  it('converts fenced code blocks with language', () => {
    expect(markdownToTelegramHtml('```ts\nconst a = 1 < 2\n```')).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2</code></pre>',
    )
    expect(markdownToTelegramHtml('```\n**not bold**\n```')).toBe('<pre>**not bold**</pre>')
  })

  it('keeps an unclosed fence to the end without throwing', () => {
    expect(markdownToTelegramHtml('```\nabc')).toBe('<pre>abc</pre>')
  })

  it('converts headings, lists, rules and quotes', () => {
    expect(markdownToTelegramHtml('## Title')).toBe('<b>Title</b>')
    expect(markdownToTelegramHtml('- a\n  * b\n2. c\n---')).toBe('• a\n  • b\n2. c\n———')
    expect(markdownToTelegramHtml('> q1\n> **q2**')).toBe('<blockquote>q1\n<b>q2</b></blockquote>')
  })

  it('wraps tables in pre', () => {
    expect(markdownToTelegramHtml('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('<pre>| a | b |\n|---|---|\n| 1 | 2 |</pre>')
  })

  it('drops nul bytes so placeholders cannot be forged', () => {
    expect(markdownToTelegramHtml('a\u00000\u0000b `c`')).toBe('a0b <code>c</code>')
  })
})

// ---------- 生命周期与轮询自愈 ----------

/** 最小 fake：instrumentPollingRecovery 会包装实例上的 getUpdates，
 * 测试直接 await fake.getUpdates() 即模拟库轮询的下一次调用（走的正是包装后的方法） */
class FakeBot extends EventEmitter {
  getMe = vi.fn(async () => ({ id: 42, is_bot: true as const, first_name: 'Bot', username: 'test_bot' }))
  startPolling = vi.fn(async () => {})
  stopPolling = vi.fn(async () => {})
  getUpdates = vi.fn(async () => [])
  setMyCommands = vi.fn(async () => true)
}

function makeChannel() {
  const fake = new FakeBot()
  const settingsRef: ConfigRef<TelegramBotChannelSettings> = {
    path: 'channels.tg',
    current: { type: 'telegram_bot', token: 'T:tg', enabled: true, drop_pending_updates: false },
    onChange: () => () => {},
  }
  const statuses: string[] = []
  const channel = new TelegramBotChannel({
    id: 'tg',
    settingsRef,
    attachmentsDir: '/tmp/unused',
    listCommands: () => [],
    listPrivilegedUserIds: () => [],
    onMessage: () => {},
    onCallback: () => {},
    onStatus: (status) => statuses.push(`${status.state}:${status.detail ?? ''}`),
    log: { info: () => {}, error: () => {} },
    createBot: () => fake as unknown as TelegramBot,
    timings: { getMeRetryBaseMs: 5, getMeRetryCapMs: 10 },
  })
  return { channel, fake, statuses }
}

describe('TelegramBotChannel 生命周期', () => {
  it('启动成功 → starting → running', async () => {
    const { channel, statuses } = makeChannel()
    await channel.start()
    expect(statuses).toEqual(['starting:', 'running:@test_bot'])
    await channel.stop()
  })

  it('polling_error 置 error；下一次 getUpdates 成功即回写 running', async () => {
    const { channel, fake } = makeChannel()
    await channel.start()
    fake.emit('polling_error', new Error('fetch failed'))
    expect(channel.status().state).toBe('error')

    await fake.getUpdates()
    expect(channel.status().state).toBe('running')
    expect(channel.status().detail).toBe('@test_bot')
    await channel.stop()
  })

  it('409 结构化判定（TelegramError.response.status），恢复后回 running', async () => {
    const { channel, fake } = makeChannel()
    await channel.start()
    fake.emit('polling_error', new TelegramError('ETELEGRAM: 409 Conflict', { status: 409 }))
    expect(channel.status().detail).toContain('409 Conflict')

    await fake.getUpdates()
    expect(channel.status().state).toBe('running')
    await channel.stop()
  })

  it('相同 polling_error 不重复广播', async () => {
    const { channel, fake, statuses } = makeChannel()
    await channel.start()
    const before = statuses.length
    fake.emit('polling_error', new Error('fetch failed'))
    fake.emit('polling_error', new Error('fetch failed'))
    expect(statuses.length).toBe(before + 1)
    await channel.stop()
  })

  it('getMe 网络错误退避重试直到成功', async () => {
    const { channel, fake, statuses } = makeChannel()
    fake.getMe.mockRejectedValueOnce(new Error('network down')).mockRejectedValueOnce(new Error('network down'))
    await channel.start()
    expect(fake.getMe).toHaveBeenCalledTimes(3)
    expect(channel.status().state).toBe('running')
    expect(statuses).toContain('error:getMe 失败（自动重试中）：network down')
    await channel.stop()
  })

  it('getMe 401 → token 终态，不再重试', async () => {
    const { channel, fake } = makeChannel()
    fake.getMe.mockRejectedValue(new TelegramError('ETELEGRAM: 401 Unauthorized', { status: 401 }))
    await channel.start()
    expect(channel.status().state).toBe('error')
    expect(channel.status().detail).toContain('token 校验失败')
    expect(fake.getMe).toHaveBeenCalledTimes(1)
  })

  it('getMe 重试等待中 stop() 立即退出，不再发起请求', async () => {
    const { channel, fake } = makeChannel()
    fake.getMe.mockRejectedValue(new Error('network down'))
    const started = channel.start()
    await vi.waitFor(() => expect(fake.getMe).toHaveBeenCalled())

    await channel.stop()
    await started
    expect(channel.status().state).toBe('stopped')
    const callsAfterStop = fake.getMe.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(fake.getMe.mock.calls.length).toBe(callsAfterStop)
  })

  it('stop 后旧实例的 getUpdates 成功不复活状态', async () => {
    const { channel, fake } = makeChannel()
    await channel.start()
    fake.emit('polling_error', new Error('fetch failed'))
    await channel.stop()

    await fake.getUpdates()
    expect(channel.status().state).toBe('stopped')
  })
})
