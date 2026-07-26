import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { InboundEnvelope } from '../../shared/messages'
import { HistoryStore } from './store'

// 现 migrate()（PRAGMA table_info + ALTER 链）的表征测试：
// 遗留库开库后列补齐、缺失表建齐、旧行可读、重开幂等。
// P4 引入 PRAGMA user_version 迁移框架后，本文件断言随之改为版本推进（数据断言不变）。

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'susie-history-test-'))
  dirs.push(dir)
  return path.join(dir, 'history.db')
}

function legacyEnvelope(): InboundEnvelope {
  return {
    message: {
      id: '10',
      channelId: 'tg',
      chatId: 'P:100',
      receiver: null,
      replyTo: null,
      out: false,
      sender: 'Mem',
      senderId: '100',
      timestamp: 1000,
      parts: [{ kind: 'text', text: '旧的审核请求' }],
    },
    chatName: null,
    mentioned: false,
  }
}

/** 迁移前的库形态：messages 无 sender_id、pending_approvals 无 auto_review_reason、无 auto_reviews 表 */
function createLegacyDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath)
  db.exec(`
CREATE TABLE messages(
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  msg_id TEXT,
  sender TEXT,
  reply_to TEXT,
  receiver TEXT,
  out INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  parts TEXT NOT NULL
);
CREATE INDEX idx_messages_chat ON messages(channel_id, chat_id, ts);
CREATE TABLE chats(
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT,
  last_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id, chat_id)
);
CREATE TABLE pending_approvals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT,
  sender TEXT,
  envelope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  card_chat_id TEXT,
  card_msg_id TEXT,
  created_ts INTEGER NOT NULL,
  decided_ts INTEGER
);
`)
  db.prepare(
    `INSERT INTO messages(channel_id, chat_id, msg_id, sender, reply_to, receiver, out, ts, parts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('tg', 'P:100', '1', 'Mem', null, null, 0, 1000, JSON.stringify([{ kind: 'text', text: '旧消息' }]))
  db.prepare(
    `INSERT INTO pending_approvals(channel_id, chat_id, sender_id, sender, envelope, status, created_ts)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  ).run('tg', 'P:100', '100', 'Mem', JSON.stringify(legacyEnvelope()), 1000)
  db.close()
}

describe('HistoryStore 遗留库迁移', () => {
  it('补齐缺失列：旧行可读（新列为 null），新列立即可写', () => {
    const dbPath = tempDbPath()
    createLegacyDb(dbPath)

    const store = new HistoryStore(dbPath)
    try {
      // 旧 message 行可读，sender_id 补列后为 null
      const messages = store.listMessages('tg', 'P:100')
      expect(messages).toHaveLength(1)
      expect(messages[0]?.senderId).toBeNull()
      expect(messages[0]?.parts).toEqual([{ kind: 'text', text: '旧消息' }])

      // sender_id 列可写可读
      const recorded = store.record({
        id: '2',
        channelId: 'tg',
        chatId: 'P:100',
        receiver: null,
        replyTo: null,
        out: false,
        sender: 'Mem',
        senderId: '100',
        timestamp: 2000,
        parts: [{ kind: 'text', text: '新消息' }],
      })
      expect(store.listMessages('tg', 'P:100').at(-1)?.senderId).toBe('100')
      expect(recorded.rowid).toBeGreaterThan(0)

      // 旧 pending 行可读，auto_review_reason 补列后为 null；且新列立即可写（reopen 落原因）
      const pending = store.getPendingApproval(1)
      expect(pending?.status).toBe('pending')
      expect(pending?.autoReviewReason).toBeNull()
      expect(pending?.envelope.message.parts).toEqual([{ kind: 'text', text: '旧的审核请求' }])
      store.claimPendingApproval(1, 'approved', 3000)
      expect(store.getPendingApproval(1)?.status).toBe('approved')
    } finally {
      store.close()
    }
  })

  it('补齐缺失表：auto_reviews 在旧库上直接可用', () => {
    const dbPath = tempDbPath()
    createLegacyDb(dbPath)

    const store = new HistoryStore(dbPath)
    try {
      const record = store.createAutoReview({
        channelId: 'tg',
        chatId: 'P:100',
        senderId: '100',
        sender: 'Mem',
        text: '审一下',
        createdTs: 1000,
      })
      expect(store.finishAutoReview(record.id, 'passed', null, 2000)?.status).toBe('passed')
    } finally {
      store.close()
    }
  })

  it('重开幂等：迁移不重复执行、数据保持', () => {
    const dbPath = tempDbPath()
    createLegacyDb(dbPath)

    const first = new HistoryStore(dbPath)
    first.close()
    const second = new HistoryStore(dbPath)
    try {
      expect(second.listMessages('tg', 'P:100')).toHaveLength(1)
      expect(second.getPendingApproval(1)?.status).toBe('pending')
    } finally {
      second.close()
    }
  })

  it('全新库：建表 + 迁移一次成型', () => {
    const dbPath = tempDbPath()
    const store = new HistoryStore(dbPath)
    try {
      expect(store.listChats()).toEqual([])
      expect(store.listPendingApprovals()).toEqual([])
      expect(store.listAutoReviews()).toEqual([])
    } finally {
      store.close()
    }
  })
})
