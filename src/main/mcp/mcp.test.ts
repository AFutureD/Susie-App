import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { StoredMessage } from '../../shared/messages'
import { resolveDateRange } from './dates'
import { parseReplyTo, SusieMcpServer, type McpBridge } from './server'

describe('parseReplyTo (send_message.reply_to 三态)', () => {
  it('缺省 → undefined（走 turn 锚点）', () => {
    expect(parseReplyTo(undefined)).toBeUndefined()
  })
  it('显式 null → null（跳出锚点）', () => {
    expect(parseReplyTo(null)).toBeNull()
  })
  it('正整数（number 或数字字符串）→ 字符串覆盖', () => {
    expect(parseReplyTo(42)).toBe('42')
    expect(parseReplyTo('42')).toBe('42')
  })
  it('非正整数 / 非数字字符串 → undefined 兜底', () => {
    expect(parseReplyTo(0)).toBeUndefined()
    expect(parseReplyTo(-1)).toBeUndefined()
    expect(parseReplyTo(1.5)).toBeUndefined()
    expect(parseReplyTo('abc')).toBeUndefined()
    expect(parseReplyTo(false)).toBeUndefined()
  })
})

describe('resolveDateRange', () => {
  const now = new Date('2026-07-22T15:00:00')

  it('supports the -Nd shorthand and single dates as whole days', () => {
    const range = resolveDateRange({ dateStart: '-2d', dateEnd: 'yesterday' }, now)
    expect(range.start).toBe(new Date('2026-07-20T00:00:00').getTime())
    expect(range.end).toBe(new Date('2026-07-21T00:00:00').getTime())
  })

  it('parses date_range spans', () => {
    const range = resolveDateRange({ dateRange: 'last week' }, now)
    expect(range.start).not.toBeNull()
    expect(range.end).not.toBeNull()
  })

  it('returns nulls for empty input', () => {
    expect(resolveDateRange({}, now)).toEqual({ start: null, end: null })
  })
})

describe('SusieMcpServer roundtrip', () => {
  const sent: unknown[] = []
  const server = new SusieMcpServer()
  let url = ''

  const fakeMessage: StoredMessage = {
    rowid: 1,
    id: '9',
    channelId: 'ch',
    chatId: 'P:1',
    receiver: null,
    replyTo: null,
    out: true,
    sender: 'susie',
    senderId: null,
    timestamp: 123,
    parts: [{ kind: 'text', text: 'pong' }],
  }

  const bridge: McpBridge = {
    sendMessage: (input) => {
      sent.push(input)
      return Promise.resolve(fakeMessage)
    },
    listMessages: () => [fakeMessage],
    listChats: () => [{ channelId: 'ch', chatId: 'P:1', name: '测试', lastTs: 123 }],
  }

  beforeAll(async () => {
    server.setBridge(bridge)
    url = await server.start(0)
  })

  afterAll(async () => {
    await server.stop()
  })

  it('serves tools over streamable http and dispatches calls', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))

    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).toSorted()).toEqual(['list_chats', 'list_messages', 'send_message'])

    const result = await client.callTool({
      name: 'send_message',
      arguments: { channel_id: 'ch', chat_id: 'P:1', content: 'hello', file: '/tmp/a.png' },
    })
    const content = result.content as { type: string; text: string }[]
    expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({ chatId: 'P:1' })
    expect(sent[0]).toEqual({ channelId: 'ch', chatId: 'P:1', content: 'hello', files: ['/tmp/a.png'] })

    const listed = await client.callTool({
      name: 'list_messages',
      arguments: { channel_id: 'ch', chat_id: 'P:1', num: 3, date_start: '-2d' },
    })
    const listedContent = listed.content as { type: string; text: string }[]
    expect(JSON.parse(listedContent[0]?.text ?? '[]')).toHaveLength(1)

    const chats = await client.callTool({ name: 'list_chats', arguments: {} })
    const chatsContent = chats.content as { type: string; text: string }[]
    expect(JSON.parse(chatsContent[0]?.text ?? '[]')[0]).toMatchObject({ name: '测试' })

    await client.close()
  })

  it('reports unknown tools as errors', async () => {
    const client = new Client({ name: 'test2', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    const result = await client.callTool({ name: 'nope', arguments: {} })
    expect(result.isError).toBe(true)
    await client.close()
  })
})
