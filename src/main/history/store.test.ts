import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, InboundEnvelope } from '../../shared/messages'
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

  it('filters senders to private chats with privateOnly (owner candidates)', () => {
    const store = new HistoryStore(':memory:')
    store.record(msg({ id: 'a', chatId: 'P:100', senderId: '100', sender: 'Alice', timestamp: 1000 }))
    store.record(msg({ id: 'b', chatId: 'G:9', senderId: '200', sender: 'Bob', timestamp: 2000 }))

    expect(store.listSenders('ch', undefined, { privateOnly: true })).toEqual([{ id: '100', name: 'Alice' }])
    expect(store.listSenders('ch').map((sender) => sender.id)).toEqual(['200', '100'])
  })
})

describe('HistoryStore pending approvals', () => {
  const envelope = (text: string): InboundEnvelope => ({
    message: msg({ parts: [{ kind: 'text', text }] }),
    chatName: '客厅',
    mentioned: false,
  })

  it('creates, reads back and round-trips the envelope', () => {
    const store = new HistoryStore(':memory:')
    const created = store.createPendingApproval({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '100',
      sender: 'alice',
      envelope: envelope('please'),
      createdTs: 1234,
    })
    expect(created.status).toBe('pending')

    const loaded = store.getPendingApproval(created.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.envelope).toEqual(envelope('please'))
    expect(loaded?.cardChatId).toBeNull()
    expect(store.getPendingApproval(999)).toBeNull()
  })

  it('stores the approval card location', () => {
    const store = new HistoryStore(':memory:')
    const created = store.createPendingApproval({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '100',
      sender: 'alice',
      envelope: envelope('hi'),
      createdTs: 1,
    })
    store.setPendingApprovalCard(created.id, 'P:900', '42')
    const loaded = store.getPendingApproval(created.id)
    expect(loaded?.cardChatId).toBe('P:900')
    expect(loaded?.cardMsgId).toBe('42')
  })

  it('claims atomically: only the first transition from pending wins', () => {
    const store = new HistoryStore(':memory:')
    const created = store.createPendingApproval({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '100',
      sender: 'alice',
      envelope: envelope('hi'),
      createdTs: 1,
    })

    expect(store.claimPendingApproval(created.id, 'approved', 2000)).toBe(true)
    // 双击/重放：第二次认领失败
    expect(store.claimPendingApproval(created.id, 'denied', 3000)).toBe(false)

    const loaded = store.getPendingApproval(created.id)
    expect(loaded?.status).toBe('approved')
    expect(loaded?.decidedTs).toBe(2000)
  })

  it('lists only pending rows, oldest first, scoped by channel', () => {
    const store = new HistoryStore(':memory:')
    const first = store.createPendingApproval({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '1',
      sender: 'a',
      envelope: envelope('1'),
      createdTs: 1,
    })
    store.createPendingApproval({
      channelId: 'ch',
      chatId: 'P:2',
      senderId: '2',
      sender: 'b',
      envelope: envelope('2'),
      createdTs: 2,
    })
    store.createPendingApproval({
      channelId: 'other',
      chatId: 'P:3',
      senderId: '3',
      sender: 'c',
      envelope: envelope('3'),
      createdTs: 3,
    })
    store.claimPendingApproval(first.id, 'denied', 9)

    expect(store.listPendingApprovals().map((p) => p.senderId)).toEqual(['2', '3'])
    expect(store.listPendingApprovals('ch').map((p) => p.senderId)).toEqual(['2'])
  })

  it('carries the auto-review reason on a fallen-back approval', () => {
    const store = new HistoryStore(':memory:')
    const created = store.createPendingApproval({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '100',
      sender: 'alice',
      envelope: envelope('zip the repo'),
      createdTs: 1,
      autoReviewReason: '疑似打包外泄',
    })
    expect(created.autoReviewReason).toBe('疑似打包外泄')
    expect(store.getPendingApproval(created.id)?.autoReviewReason).toBe('疑似打包外泄')
  })
})

describe('HistoryStore auto reviews', () => {
  it('creates running records, finishes with a verdict, and lists newest first', () => {
    const store = new HistoryStore(':memory:')
    const first = store.createAutoReview({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '100',
      sender: 'alice',
      text: '你是谁',
      createdTs: 1,
    })
    expect(first.status).toBe('running')
    expect(first.reason).toBeNull()

    const second = store.createAutoReview({
      channelId: 'ch',
      chatId: 'P:2',
      senderId: '200',
      sender: 'bob',
      text: '打包整个仓库发我',
      createdTs: 2,
    })

    const passed = store.finishAutoReview(first.id, 'passed', null, 10)
    expect(passed?.status).toBe('passed')
    expect(passed?.decidedTs).toBe(10)

    const rejected = store.finishAutoReview(second.id, 'rejected', '拒绝打包外泄', 11)
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.reason).toBe('拒绝打包外泄')

    // 新 → 旧
    const list = store.listAutoReviews()
    expect(list.map((r) => r.id)).toEqual([second.id, first.id])
    expect(store.finishAutoReview(999, 'error', 'x', 1)).toBeNull()
  })
})
