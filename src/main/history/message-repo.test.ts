import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../shared/messages'
import { AppDatabase } from '../db/database'
import { MessageRepo } from './message-repo'

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '1',
    channelId: 'ch',
    chatId: 'P:1',
    receiver: null,
    replyTo: null,
    out: false,
    sender: 'alice',
    senderId: '100',
    timestamp: 1000,
    parts: [{ kind: 'text', text: 'hello world' }],
    ...overrides,
  }
}

function makeRepo(): MessageRepo {
  return new MessageRepo(new AppDatabase(':memory:'))
}

describe('MessageRepo (node:sqlite)', () => {
  it('records messages and lists them oldest-first', () => {
    const repo = makeRepo()
    repo.record(msg({ id: 'a', timestamp: 1000 }), '客厅')
    repo.record(msg({ id: 'b', timestamp: 2000, out: true, sender: 'susie' }))

    const list = repo.listMessages('ch', 'P:1')
    expect(list.map((m) => m.id)).toEqual(['a', 'b'])
    expect(list[1]?.out).toBe(true)
    expect(list[0]?.parts[0]).toEqual({ kind: 'text', text: 'hello world' })
  })

  it('tracks chats with name and last timestamp', () => {
    const repo = makeRepo()
    repo.record(msg({ chatId: 'P:1', timestamp: 500 }), '甲')
    repo.record(msg({ chatId: 'G:2', timestamp: 900 }), '乙')
    repo.record(msg({ chatId: 'P:1', timestamp: 1500 }))

    const chats = repo.listChats()
    expect(chats.map((c) => c.chatId)).toEqual(['P:1', 'G:2'])
    expect(chats[0]?.name).toBe('甲')
    expect(chats[0]?.lastTs).toBe(1500)
  })

  it('paginates with beforeId and filters by date', () => {
    const repo = makeRepo()
    for (let i = 1; i <= 10; i += 1) {
      repo.record(msg({ id: String(i), timestamp: i * 1000 }))
    }
    const lastTwo = repo.listMessages('ch', 'P:1', { limit: 2 })
    expect(lastTwo.map((m) => m.id)).toEqual(['9', '10'])

    const before = repo.listMessages('ch', 'P:1', { limit: 3, beforeId: lastTwo[0]?.rowid ?? 0 })
    expect(before.map((m) => m.id)).toEqual(['6', '7', '8'])

    const ranged = repo.listMessages('ch', 'P:1', { dateStart: 3000, dateEnd: 5000 })
    expect(ranged.map((m) => m.id)).toEqual(['3', '4', '5'])
  })

  it('lists distinct senders newest-first with the latest name, skipping own and id-less messages', () => {
    const repo = makeRepo()
    repo.record(msg({ id: 'a', senderId: '100', sender: '旧名', timestamp: 1000 }))
    repo.record(msg({ id: 'b', senderId: '200', sender: 'Bob', timestamp: 2000 }))
    repo.record(msg({ id: 'c', senderId: '100', sender: '新名', timestamp: 3000 }))
    repo.record(msg({ id: 'd', senderId: null, sender: 'legacy', timestamp: 4000 }))
    repo.record(msg({ id: 'e', senderId: '300', sender: 'susie', out: true, timestamp: 5000 }))

    expect(repo.listSenders('ch', 'P:1')).toEqual([
      { id: '100', name: '新名' },
      { id: '200', name: 'Bob' },
    ])
    expect(repo.listSenders('ch', 'G:9')).toEqual([])

    // chatId 省略 → 跨该频道全部会话
    repo.record(msg({ id: 'g', chatId: 'G:9', senderId: '300', sender: 'Carol', timestamp: 9000 }))
    expect(repo.listSenders('ch').map((sender) => sender.id)).toEqual(['300', '100', '200'])
    expect(repo.listSenders('other')).toEqual([])
  })

  it('searches across parts with LIKE escaping', () => {
    const repo = makeRepo()
    repo.record(msg({ id: 'x', parts: [{ kind: 'text', text: '100% sure' }] }))
    repo.record(msg({ id: 'y', parts: [{ kind: 'text', text: 'nothing' }] }))

    expect(repo.search('100%').map((m) => m.id)).toEqual(['x'])
    expect(repo.search('missing')).toHaveLength(0)
  })

  it('filters senders to private chats with privateOnly (owner candidates)', () => {
    const repo = makeRepo()
    repo.record(msg({ id: 'a', chatId: 'P:100', senderId: '100', sender: 'Alice', timestamp: 1000 }))
    repo.record(msg({ id: 'b', chatId: 'G:9', senderId: '200', sender: 'Bob', timestamp: 2000 }))

    expect(repo.listSenders('ch', undefined, { privateOnly: true })).toEqual([{ id: '100', name: 'Alice' }])
    expect(repo.listSenders('ch').map((sender) => sender.id)).toEqual(['200', '100'])
  })
})
