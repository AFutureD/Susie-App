import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../../shared/messages'
import { HistoryStore } from './store'

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

describe('HistoryStore (node:sqlite)', () => {
  it('records messages and lists them oldest-first', () => {
    const store = new HistoryStore(':memory:')
    store.record(msg({ id: 'a', timestamp: 1000 }), '客厅')
    store.record(msg({ id: 'b', timestamp: 2000, out: true, sender: 'susie' }))

    const list = store.listMessages('ch', 'P:1')
    expect(list.map((m) => m.id)).toEqual(['a', 'b'])
    expect(list[1]?.out).toBe(true)
    expect(list[0]?.parts[0]).toEqual({ kind: 'text', text: 'hello world' })
  })

  it('tracks chats with name and last timestamp', () => {
    const store = new HistoryStore(':memory:')
    store.record(msg({ chatId: 'P:1', timestamp: 500 }), '甲')
    store.record(msg({ chatId: 'G:2', timestamp: 900 }), '乙')
    store.record(msg({ chatId: 'P:1', timestamp: 1500 }))

    const chats = store.listChats()
    expect(chats.map((c) => c.chatId)).toEqual(['P:1', 'G:2'])
    expect(chats[0]?.name).toBe('甲')
    expect(chats[0]?.lastTs).toBe(1500)
  })

  it('paginates with beforeId and filters by date', () => {
    const store = new HistoryStore(':memory:')
    for (let i = 1; i <= 10; i += 1) {
      store.record(msg({ id: String(i), timestamp: i * 1000 }))
    }
    const lastTwo = store.listMessages('ch', 'P:1', { limit: 2 })
    expect(lastTwo.map((m) => m.id)).toEqual(['9', '10'])

    const before = store.listMessages('ch', 'P:1', { limit: 3, beforeId: lastTwo[0]?.rowid ?? 0 })
    expect(before.map((m) => m.id)).toEqual(['6', '7', '8'])

    const ranged = store.listMessages('ch', 'P:1', { dateStart: 3000, dateEnd: 5000 })
    expect(ranged.map((m) => m.id)).toEqual(['3', '4', '5'])
  })

  it('lists distinct senders newest-first with the latest name, skipping own and id-less messages', () => {
    const store = new HistoryStore(':memory:')
    store.record(msg({ id: 'a', senderId: '100', sender: '旧名', timestamp: 1000 }))
    store.record(msg({ id: 'b', senderId: '200', sender: 'Bob', timestamp: 2000 }))
    store.record(msg({ id: 'c', senderId: '100', sender: '新名', timestamp: 3000 }))
    store.record(msg({ id: 'd', senderId: null, sender: 'legacy', timestamp: 4000 }))
    store.record(msg({ id: 'e', senderId: '300', sender: 'susie', out: true, timestamp: 5000 }))

    expect(store.listSenders('ch', 'P:1')).toEqual([
      { id: '100', name: '新名' },
      { id: '200', name: 'Bob' },
    ])
    expect(store.listSenders('ch', 'G:9')).toEqual([])

    // chatId 省略 → 跨该频道全部会话
    store.record(msg({ id: 'g', chatId: 'G:9', senderId: '300', sender: 'Carol', timestamp: 9000 }))
    expect(store.listSenders('ch').map((sender) => sender.id)).toEqual(['300', '100', '200'])
    expect(store.listSenders('other')).toEqual([])
  })

  it('migrates an existing database without the sender_id column', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'susie-history-'))
    const dbPath = path.join(dir, 'history.db')
    const legacy = new DatabaseSync(dbPath)
    legacy.exec(`
      CREATE TABLE messages(
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_id TEXT NOT NULL, chat_id TEXT NOT NULL, msg_id TEXT,
        sender TEXT, reply_to TEXT, receiver TEXT,
        out INTEGER NOT NULL, ts INTEGER NOT NULL, parts TEXT NOT NULL
      );
      INSERT INTO messages(channel_id, chat_id, msg_id, sender, out, ts, parts)
        VALUES ('ch', 'P:1', 'old', 'alice', 0, 100, '[]');
    `)
    legacy.close()

    const store = new HistoryStore(dbPath)
    expect(store.listMessages('ch', 'P:1')[0]?.senderId).toBeNull()
    store.record(msg({ id: 'new', senderId: '7', timestamp: 200 }))
    expect(store.listSenders('ch', 'P:1')).toEqual([{ id: '7', name: 'alice' }])
    store.close()
  })

  it('searches across parts with LIKE escaping', () => {
    const store = new HistoryStore(':memory:')
    store.record(msg({ id: 'x', parts: [{ kind: 'text', text: '100% sure' }] }))
    store.record(msg({ id: 'y', parts: [{ kind: 'text', text: 'nothing' }] }))

    expect(store.search('100%').map((m) => m.id)).toEqual(['x'])
    expect(store.search('missing')).toHaveLength(0)
  })
})
