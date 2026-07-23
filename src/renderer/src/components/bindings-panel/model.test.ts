import { describe, expect, it } from 'vitest'
import { configSchema } from '../../../../shared/config'
import type { ChatInfo } from '../../../../shared/messages'
import { buildTree } from './model'

function makeConfig(overrides: Record<string, unknown>) {
  return configSchema.parse({
    channels: {
      bot: { type: 'telegram_bot', token: '1:x' },
    },
    assistants: [{ id: 'default' }, { id: 'ops' }],
    ...overrides,
  })
}

const chat = (channelId: string, chatId: string, name: string | null): ChatInfo => ({
  channelId,
  chatId,
  name,
  lastTs: 0,
})

describe('buildTree', () => {
  it('derives rows from exact bindings and carries trigger attributes', () => {
    const config = makeConfig({
      bindings: [
        { channel: 'bot', chat_id: 'S:-1', assistant_id: 'ops', only_mention: false, members: ['7'] },
        { channel: 'bot', chat_id: '*', assistant_id: 'default' },
      ],
    })
    const tree = buildTree(config, [chat('bot', 'S:-1', '大群')], [])
    expect(tree).toHaveLength(1)
    expect(tree[0]?.defaultAssistantId).toBe('default')
    expect(tree[0]?.rows).toEqual([
      {
        channelId: 'bot',
        chatId: 'S:-1',
        name: '大群',
        chatType: 'supergroup',
        threadId: null,
        assignment: { assistantId: 'ops', onlyMention: false, members: ['7'] },
      },
    ])
  })

  it('reports 无通道默认 as null (禁止)', () => {
    const config = makeConfig({
      bindings: [{ channel: 'bot', chat_id: 'P:1', assistant_id: 'ops' }],
    })
    const tree = buildTree(config, [], [])
    expect(tree[0]?.defaultAssistantId).toBeNull()
    expect(tree[0]?.rows[0]?.assignment?.assistantId).toBe('ops')
  })

  it('keeps drafts visible (assignment null) and marks dead-channel bindings as ghosts', () => {
    const config = makeConfig({
      bindings: [{ channel: 'gone', chat_id: 'G:9', assistant_id: 'ops' }],
    })
    const tree = buildTree(config, [], [{ channelId: 'bot', chatId: 'P:5', name: null }])
    expect(tree.map((entry) => [entry.channelId, entry.ghost])).toEqual([
      ['bot', false],
      ['gone', true],
    ])
    expect(tree[0]?.rows).toEqual([
      { channelId: 'bot', chatId: 'P:5', name: null, chatType: 'private', threadId: null, assignment: null },
    ])
    expect(tree[1]?.rows.map((row) => row.chatId)).toEqual(['G:9'])
  })
})
