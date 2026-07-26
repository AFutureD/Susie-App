import type { DatabaseSync } from 'node:sqlite'
import type {
  AutoReviewRecord,
  AutoReviewStatus,
  ChatInfo,
  ChatMessage,
  InboundEnvelope,
  MessagePart,
  SenderInfo,
  StoredMessage,
} from '../../shared/messages'
import { AppDatabase } from '../db/database'

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

/**
 * 审批状态机：
 * - review 档：pending →（owner 裁决）approved / denied；发送失败 failed
 * - auto 档：auto_reviewing →（自动通过）auto_passed →（owner 急停）terminated
 *            auto_reviewing →（自动拒绝）pending → 走人工裁决
 */
export type ApprovalStatus =
  'pending' | 'approved' | 'denied' | 'failed' | 'auto_reviewing' | 'auto_passed' | 'terminated'

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
  /** 由自动审核未通过回落而来时的原因；纯人工审核为 null */
  autoReviewReason: string | null
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
  auto_review_reason: string | null
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
    autoReviewReason: row.auto_review_reason,
    createdTs: row.created_ts,
    decidedTs: row.decided_ts,
  }
}

interface AutoReviewRow {
  id: number
  channel_id: string
  chat_id: string
  sender_id: string | null
  sender: string | null
  text: string
  status: string
  reason: string | null
  created_ts: number
  decided_ts: number | null
}

function rowToAutoReview(row: AutoReviewRow): AutoReviewRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    sender: row.sender,
    text: row.text,
    status: row.status as AutoReviewStatus,
    reason: row.reason,
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
  private readonly appDb: AppDatabase
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    this.appDb = new AppDatabase(dbPath)
    this.db = this.appDb.db
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
    /** 由自动审核未通过回落而来时的原因（附到审核卡片）；纯人工审核省略 */
    autoReviewReason?: string | null
    /** 初始状态：人工审核 pending（默认）；auto 档发「审核中」卡片时 auto_reviewing */
    status?: 'pending' | 'auto_reviewing'
  }): PendingApproval {
    const autoReviewReason = input.autoReviewReason ?? null
    const status = input.status ?? 'pending'
    const result = this.db
      .prepare(
        `INSERT INTO pending_approvals(channel_id, chat_id, sender_id, sender, envelope, status, auto_review_reason, created_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.channelId,
        input.chatId,
        input.senderId,
        input.sender,
        JSON.stringify(input.envelope),
        status,
        autoReviewReason,
        input.createdTs,
      )
    return {
      id: Number(result.lastInsertRowid),
      channelId: input.channelId,
      chatId: input.chatId,
      senderId: input.senderId,
      sender: input.sender,
      envelope: input.envelope,
      status,
      cardChatId: null,
      cardMsgId: null,
      autoReviewReason,
      createdTs: input.createdTs,
      decidedTs: null,
    }
  }

  // ---------- 自动审核历史与进度 ----------

  /** 建一条自动审核记录（status = running），供进度展示 */
  createAutoReview(input: {
    channelId: string
    chatId: string
    senderId: string | null
    sender: string | null
    text: string
    createdTs: number
  }): AutoReviewRecord {
    const result = this.db
      .prepare(
        `INSERT INTO auto_reviews(channel_id, chat_id, sender_id, sender, text, status, created_ts)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(input.channelId, input.chatId, input.senderId, input.sender, input.text, input.createdTs)
    return {
      id: Number(result.lastInsertRowid),
      channelId: input.channelId,
      chatId: input.chatId,
      senderId: input.senderId,
      sender: input.sender,
      text: input.text,
      status: 'running',
      reason: null,
      createdTs: input.createdTs,
      decidedTs: null,
    }
  }

  /** 落定自动审核结论（passed/rejected/error）；记录不存在返回 null */
  finishAutoReview(
    id: number,
    status: Exclude<AutoReviewStatus, 'running'>,
    reason: string | null,
    decidedTs: number,
  ): AutoReviewRecord | null {
    this.db
      .prepare('UPDATE auto_reviews SET status = ?, reason = ?, decided_ts = ? WHERE id = ?')
      .run(status, reason, decidedTs, id)
    return this.getAutoReview(id)
  }

  getAutoReview(id: number): AutoReviewRecord | null {
    const row = this.db.prepare('SELECT * FROM auto_reviews WHERE id = ?').get(id) as unknown as
      AutoReviewRow | undefined
    return row === undefined ? null : rowToAutoReview(row)
  }

  /** 最近的自动审核记录（新 → 旧） */
  listAutoReviews(limit = 50): AutoReviewRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM auto_reviews ORDER BY id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 200)) as unknown as AutoReviewRow[]
    return rows.map(rowToAutoReview)
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
   * 原子认领：仅 from 态（默认 pending）可迁移到目标态。返回 false = 已被处理
   * （owner 双击按钮 / 重启后 Telegram 重放回调的去重依据）。
   */
  claimPendingApproval(
    id: number,
    status: Exclude<ApprovalStatus, 'pending' | 'auto_reviewing'>,
    decidedTs: number,
    from: ApprovalStatus = 'pending',
  ): boolean {
    const result = this.db
      .prepare(`UPDATE pending_approvals SET status = ?, decided_ts = ? WHERE id = ? AND status = ?`)
      .run(status, decidedTs, id, from)
    return Number(result.changes) === 1
  }

  /**
   * 自动审核拒绝：auto_reviewing → pending 转人工裁决，并落拒绝原因（原子，双写只有第一次生效）。
   * 不设 decided_ts——转人工不是终局裁决。
   */
  reopenPendingApproval(id: number, autoReviewReason: string | null): boolean {
    const result = this.db
      .prepare(
        `UPDATE pending_approvals SET status = 'pending', auto_review_reason = ?
         WHERE id = ? AND status = 'auto_reviewing'`,
      )
      .run(autoReviewReason, id)
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
    this.appDb.close()
  }
}
