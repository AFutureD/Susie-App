import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ChatInfo, ChatMessage, MessagePart, SenderInfo, StoredMessage } from '../../shared/messages'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages(
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  msg_id TEXT,
  sender TEXT,
  sender_id TEXT,
  reply_to TEXT,
  receiver TEXT,
  out INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  parts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(channel_id, chat_id, ts);
CREATE TABLE IF NOT EXISTS chats(
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT,
  last_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id, chat_id)
);
`

interface MessageRow {
  rowid: number
  channel_id: string
  chat_id: string
  msg_id: string | null
  sender: string | null
  sender_id: string | null
  reply_to: string | null
  receiver: string | null
  out: number
  ts: number
  parts: string
}

function rowToMessage(row: MessageRow): StoredMessage {
  let parts: MessagePart[]
  try {
    parts = JSON.parse(row.parts) as MessagePart[]
  } catch {
    parts = [{ kind: 'text', text: row.parts }]
  }
  return {
    rowid: row.rowid,
    id: row.msg_id,
    channelId: row.channel_id,
    chatId: row.chat_id,
    receiver: row.receiver,
    replyTo: row.reply_to,
    out: row.out === 1,
    sender: row.sender,
    senderId: row.sender_id,
    timestamp: row.ts,
    parts,
  }
}

/**
 * 对话历史（node:sqlite，零原生依赖）。
 * 兼作 MCP list_messages / list_chats 的数据源——Bot API 拉不到历史，本地库是唯一权威。
 */
export class HistoryStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.migrate()
  }

  /** 既有库的列迁移：CREATE TABLE IF NOT EXISTS 不会给老表加新列 */
  private migrate(): void {
    const columns = this.db.prepare('PRAGMA table_info(messages)').all() as unknown as { name: string }[]
    if (!columns.some((column) => column.name === 'sender_id')) {
      this.db.exec('ALTER TABLE messages ADD COLUMN sender_id TEXT')
    }
  }

  record(message: ChatMessage, chatName?: string | null): StoredMessage {
    const result = this.db
      .prepare(
        `INSERT INTO messages(channel_id, chat_id, msg_id, sender, sender_id, reply_to, receiver, out, ts, parts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.channelId,
        message.chatId,
        message.id,
        message.sender,
        message.senderId,
        message.replyTo,
        message.receiver,
        message.out ? 1 : 0,
        message.timestamp,
        JSON.stringify(message.parts),
      )

    this.db
      .prepare(
        `INSERT INTO chats(channel_id, chat_id, name, last_ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(channel_id, chat_id) DO UPDATE SET
           name = COALESCE(excluded.name, chats.name),
           last_ts = MAX(chats.last_ts, excluded.last_ts)`,
      )
      .run(message.channelId, message.chatId, chatName ?? null, message.timestamp)

    return { ...message, rowid: Number(result.lastInsertRowid) }
  }

  /** 按时间正序返回（老 → 新）。beforeId 用于向上翻页。 */
  listMessages(
    channelId: string,
    chatId: string,
    options: { limit?: number; beforeId?: number; dateStart?: number | null; dateEnd?: number | null } = {},
  ): StoredMessage[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)
    const clauses = ['channel_id = ?', 'chat_id = ?']
    const params: (string | number)[] = [channelId, chatId]

    if (options.beforeId !== undefined) {
      clauses.push('rowid < ?')
      params.push(options.beforeId)
    }
    if (options.dateStart !== undefined && options.dateStart !== null) {
      clauses.push('ts >= ?')
      params.push(options.dateStart)
    }
    if (options.dateEnd !== undefined && options.dateEnd !== null) {
      clauses.push('ts <= ?')
      params.push(options.dateEnd)
    }

    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
      .all(...params, limit) as unknown as MessageRow[]

    return rows.map(rowToMessage).toReversed()
  }

  listChats(channelId?: string): ChatInfo[] {
    const rows = (channelId === undefined
      ? this.db.prepare('SELECT * FROM chats ORDER BY last_ts DESC').all()
      : this.db
          .prepare('SELECT * FROM chats WHERE channel_id = ? ORDER BY last_ts DESC')
          .all(channelId)) as unknown as { channel_id: string; chat_id: string; name: string | null; last_ts: number }[]

    return rows.map((row) => ({ channelId: row.channel_id, chatId: row.chat_id, name: row.name, lastTs: row.last_ts }))
  }

  /**
   * 出现过的发送者（按最近发言排序，名字取最近一次）；chatId 省略时跨该频道全部会话。
   * 排除本方消息与无 id 的旧记录。
   */
  listSenders(channelId: string, chatId?: string): SenderInfo[] {
    const clauses = ['channel_id = ?', 'sender_id IS NOT NULL', 'out = 0']
    const params: string[] = [channelId]
    if (chatId !== undefined) {
      clauses.push('chat_id = ?')
      params.push(chatId)
    }
    const rows = this.db
      .prepare(
        `SELECT sender_id, sender, MAX(ts) AS last_ts FROM messages
         WHERE ${clauses.join(' AND ')}
         GROUP BY sender_id ORDER BY last_ts DESC`,
      )
      .all(...params) as unknown as { sender_id: string; sender: string | null }[]
    return rows.map((row) => ({ id: row.sender_id, name: row.sender }))
  }

  upsertChat(channelId: string, chatId: string, name: string | null): void {
    this.db
      .prepare(
        `INSERT INTO chats(channel_id, chat_id, name, last_ts) VALUES (?, ?, ?, 0)
         ON CONFLICT(channel_id, chat_id) DO UPDATE SET name = COALESCE(excluded.name, chats.name)`,
      )
      .run(channelId, chatId, name)
  }

  search(q: string, limit = 50): StoredMessage[] {
    const escaped = q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE parts LIKE ? ESCAPE '\\' ORDER BY rowid DESC LIMIT ?`)
      .all(`%${escaped}%`, Math.min(limit, 200)) as unknown as MessageRow[]
    return rows.map(rowToMessage)
  }

  close(): void {
    this.db.close()
  }
}
