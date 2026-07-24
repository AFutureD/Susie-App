import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  ChatInfo,
  ChatMessage,
  InboundEnvelope,
  MessagePart,
  SenderInfo,
  StoredMessage,
} from '../../shared/messages'

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
CREATE TABLE IF NOT EXISTS pending_approvals(
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
CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status, channel_id);
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

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'failed'

/** member 消息的审核暂存（重启后 Telegram 卡片按钮仍要可用，故持久化） */
export interface PendingApproval {
  id: number
  channelId: string
  chatId: string
  senderId: string | null
  sender: string | null
  envelope: InboundEnvelope
  status: ApprovalStatus
  /** 审核卡片所在会话（owner 私聊）与消息 id，用于事后编辑 */
  cardChatId: string | null
  cardMsgId: string | null
  createdTs: number
  decidedTs: number | null
}

interface PendingApprovalRow {
  id: number
  channel_id: string
  chat_id: string
  sender_id: string | null
  sender: string | null
  envelope: string
  status: string
  card_chat_id: string | null
  card_msg_id: string | null
  created_ts: number
  decided_ts: number | null
}

/** envelope JSON 损坏时返回 null（视为该请求已丢失） */
function rowToPendingApproval(row: PendingApprovalRow): PendingApproval | null {
  let envelope: InboundEnvelope
  try {
    envelope = JSON.parse(row.envelope) as InboundEnvelope
  } catch {
    return null
  }
  if (typeof envelope !== 'object' || envelope === null || typeof envelope.message !== 'object') return null
  return {
    id: row.id,
    channelId: row.channel_id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    sender: row.sender,
    envelope,
    status: row.status as ApprovalStatus,
    cardChatId: row.card_chat_id,
    cardMsgId: row.card_msg_id,
    createdTs: row.created_ts,
    decidedTs: row.decided_ts,
  }
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
   * 排除本方消息与无 id 的旧记录。privateOnly 仅统计私聊（owner 候选：私聊过 bot 才能收到审核卡片）。
   */
  listSenders(channelId: string, chatId?: string, options: { privateOnly?: boolean } = {}): SenderInfo[] {
    const clauses = ['channel_id = ?', 'sender_id IS NOT NULL', 'out = 0']
    const params: string[] = [channelId]
    if (chatId !== undefined) {
      clauses.push('chat_id = ?')
      params.push(chatId)
    }
    if (options.privateOnly === true) {
      clauses.push("chat_id LIKE 'P:%'")
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

  // ---------- member 消息审核暂存 ----------

  createPendingApproval(input: {
    channelId: string
    chatId: string
    senderId: string | null
    sender: string | null
    envelope: InboundEnvelope
    createdTs: number
  }): PendingApproval {
    const result = this.db
      .prepare(
        `INSERT INTO pending_approvals(channel_id, chat_id, sender_id, sender, envelope, status, created_ts)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(input.channelId, input.chatId, input.senderId, input.sender, JSON.stringify(input.envelope), input.createdTs)
    return {
      id: Number(result.lastInsertRowid),
      channelId: input.channelId,
      chatId: input.chatId,
      senderId: input.senderId,
      sender: input.sender,
      envelope: input.envelope,
      status: 'pending',
      cardChatId: null,
      cardMsgId: null,
      createdTs: input.createdTs,
      decidedTs: null,
    }
  }

  getPendingApproval(id: number): PendingApproval | null {
    const row = this.db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as unknown as
      PendingApprovalRow | undefined
    if (row === undefined) return null
    return rowToPendingApproval(row)
  }

  /** 记录审核卡片位置（发送成功后回填，用于事后编辑卡片） */
  setPendingApprovalCard(id: number, cardChatId: string, cardMsgId: string | null): void {
    this.db
      .prepare('UPDATE pending_approvals SET card_chat_id = ?, card_msg_id = ? WHERE id = ?')
      .run(cardChatId, cardMsgId, id)
  }

  /**
   * 原子认领：仅 pending 态可迁移到目标态。返回 false = 已被处理
   * （owner 双击按钮 / 重启后 Telegram 重放回调的去重依据）。
   */
  claimPendingApproval(id: number, status: Exclude<ApprovalStatus, 'pending'>, decidedTs: number): boolean {
    const result = this.db
      .prepare(`UPDATE pending_approvals SET status = ?, decided_ts = ? WHERE id = ? AND status = 'pending'`)
      .run(status, decidedTs, id)
    return Number(result.changes) === 1
  }

  /** 未决审核（老 → 新）；envelope 损坏的行跳过 */
  listPendingApprovals(channelId?: string): PendingApproval[] {
    const rows = (channelId === undefined
      ? this.db.prepare(`SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY id`).all()
      : this.db
          .prepare(`SELECT * FROM pending_approvals WHERE status = 'pending' AND channel_id = ? ORDER BY id`)
          .all(channelId)) as unknown as PendingApprovalRow[]
    return rows.map(rowToPendingApproval).filter((row) => row !== null)
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
