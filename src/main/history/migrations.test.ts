import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import type { InboundEnvelope } from '../../shared/messages'
import { AppDatabase } from '../db/database'
import { MIGRATIONS, runMigrations, type Migration } from '../db/migrations'
import { ApprovalRepo } from '../core/approval-repo'
import { AutoReviewRepo } from '../core/auto-review-repo'
import { TaskRunRepo } from '../tasks/task-run-repo'
import { MessageRepo } from './message-repo'

// 迁移框架（PRAGMA user_version + 有序 Migration[]）的行为测试：
// 遗留库（user_version=0，表已建/列可能已补）开库后列补齐、缺失表建齐、旧行可读、重开幂等。

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath)
  try {
    const row = db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }
    return Number(row.user_version)
  } finally {
    db.close()
  }
}

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

    const db = new AppDatabase(dbPath)
    try {
      const messageRepo = new MessageRepo(db)
      const approvalRepo = new ApprovalRepo(db)

      // 旧 message 行可读，sender_id 补列后为 null
      const messages = messageRepo.listMessages('tg', 'P:100')
      expect(messages).toHaveLength(1)
      expect(messages[0]?.senderId).toBeNull()
      expect(messages[0]?.parts).toEqual([{ kind: 'text', text: '旧消息' }])

      // sender_id 列可写可读
      const recorded = messageRepo.record({
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
      expect(messageRepo.listMessages('tg', 'P:100').at(-1)?.senderId).toBe('100')
      expect(recorded.rowid).toBeGreaterThan(0)

      // 旧 pending 行可读，auto_review_reason 补列后为 null；且新列立即可写
      const pending = approvalRepo.get(1)
      expect(pending?.status).toBe('pending')
      expect(pending?.autoReviewReason).toBeNull()
      expect(pending?.envelope.message.parts).toEqual([{ kind: 'text', text: '旧的审核请求' }])
      approvalRepo.claim(1, 'approved', 3000)
      expect(approvalRepo.get(1)?.status).toBe('approved')
    } finally {
      db.close()
    }
  })

  it('补齐缺失表：auto_reviews / task_runs 在旧库上直接可用', () => {
    const dbPath = tempDbPath()
    createLegacyDb(dbPath)

    const db = new AppDatabase(dbPath)
    try {
      const reviews = new AutoReviewRepo(db)
      const record = reviews.create({
        channelId: 'tg',
        chatId: 'P:100',
        senderId: '100',
        sender: 'Mem',
        text: '审一下',
        createdTs: 1000,
      })
      expect(reviews.finish(record.id, 'passed', null, 2000)?.status).toBe('passed')

      const runs = new TaskRunRepo(db)
      const run = runs.create({ taskId: 't1', taskName: '晨报', trigger: 'schedule', startedTs: 1000 })
      expect(
        runs.finish(run.id, { status: 'ok', result: 'r', error: null, deliveries: [], finishedTs: 2000 })?.status,
      ).toBe('ok')
    } finally {
      db.close()
    }
  })

  it('重开幂等：迁移不重复执行、数据保持', () => {
    const dbPath = tempDbPath()
    createLegacyDb(dbPath)

    const first = new AppDatabase(dbPath)
    first.close()
    const second = new AppDatabase(dbPath)
    try {
      expect(new MessageRepo(second).listMessages('tg', 'P:100')).toHaveLength(1)
      expect(new ApprovalRepo(second).get(1)?.status).toBe('pending')
    } finally {
      second.close()
    }
  })

  it('全新库：建表 + 迁移一次成型', () => {
    const dbPath = tempDbPath()
    const db = new AppDatabase(dbPath)
    try {
      expect(new MessageRepo(db).listChats()).toEqual([])
      expect(new ApprovalRepo(db).listPending()).toEqual([])
      expect(new AutoReviewRepo(db).list()).toEqual([])
      expect(new TaskRunRepo(db).list()).toEqual([])
    } finally {
      db.close()
    }
    expect(userVersion(dbPath)).toBe(MIGRATIONS.at(-1)?.id)
  })

  it('user_version 推进到最新迁移 id（遗留库同样收敛）', () => {
    const dbPath = tempDbPath()
    createLegacyDb(dbPath)
    new AppDatabase(dbPath).close()
    expect(userVersion(dbPath)).toBe(MIGRATIONS.at(-1)?.id)
  })

  it('envelope_v：迁移后既有行默认版本 1（迁移 4）', () => {
    const dbPath = tempDbPath()
    createLegacyDb(dbPath)
    const db = new AppDatabase(dbPath)
    try {
      const row = db.db.prepare('SELECT envelope_v FROM pending_approvals WHERE id = 1').get() as unknown as {
        envelope_v: number
      }
      expect(row.envelope_v).toBe(1)
    } finally {
      db.close()
    }
  })
})

describe('runMigrations 框架', () => {
  it('只执行 id 大于 user_version 的迁移，且逐条推进版本', () => {
    const db = new DatabaseSync(':memory:')
    const applied: number[] = []
    const migrations: Migration[] = [
      { id: 1, comment: 'a', up: () => applied.push(1) },
      { id: 2, comment: 'b', up: () => applied.push(2) },
    ]
    runMigrations(db, migrations)
    expect(applied).toEqual([1, 2])

    runMigrations(db, migrations)
    expect(applied).toEqual([1, 2]) // 幂等：已应用不重跑

    migrations.push({ id: 3, comment: 'c', up: () => applied.push(3) })
    runMigrations(db, migrations)
    expect(applied).toEqual([1, 2, 3])
    db.close()
  })

  it('迁移失败：事务回滚、版本不推进、错误带迁移 id', () => {
    const db = new DatabaseSync(':memory:')
    const migrations: Migration[] = [
      {
        id: 1,
        comment: 'creates then explodes',
        up(target) {
          target.exec('CREATE TABLE half_done(x)')
          throw new Error('boom')
        },
      },
    ]
    expect(() => runMigrations(db, migrations)).toThrow('#1')
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as {
      name: string
    }[]
    expect(tables.some((t) => t.name === 'half_done')).toBe(false)
    const row = db.prepare('PRAGMA user_version').get() as unknown as { user_version: number }
    expect(Number(row.user_version)).toBe(0)
    db.close()
  })

  it('id 不递增：拒绝执行', () => {
    const db = new DatabaseSync(':memory:')
    const migrations: Migration[] = [
      { id: 2, comment: 'b', up: () => {} },
      { id: 1, comment: 'a', up: () => {} },
    ]
    expect(() => runMigrations(db, migrations)).toThrow('严格递增')
    db.close()
  })
})
