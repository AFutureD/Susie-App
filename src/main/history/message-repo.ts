import type { DatabaseSync } from 'node:sqlite'
import type { ChatInfo, ChatMessage, MessagePart, SenderInfo, StoredMessage } from '../../shared/messages'
import type { AppDatabase } from '../db/database'

// 对话历史仓储（messages + chats）。chats 是 messages 的派生索引：唯一写路径是
// record() 的一笔逻辑操作写两表，因此二者同仓不拆。
// 兼作 MCP list_messages / list_chats 的数据源——Bot API 拉不到历史，本地库是唯一权威。

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

export class MessageRepo {
  private readonly db: DatabaseSync

  constructor(database: AppDatabase) {
    this.db = database.db
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
}
