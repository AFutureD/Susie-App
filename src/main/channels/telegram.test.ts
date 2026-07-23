import { describe, expect, it } from 'vitest'
import { decodeChatId, encodeChatId } from '../../shared/chat-id'
import { toBotCommands } from './telegram-bot'
import { markdownToTelegramHtml } from './telegram-markdown'
import { escapeHtml, renderMessageHtml, renderMessagePlain } from './telegram-render'

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
