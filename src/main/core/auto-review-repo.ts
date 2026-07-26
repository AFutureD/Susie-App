import type { DatabaseSync } from 'node:sqlite'
import type { AutoReviewRecord, AutoReviewStatus } from '../../shared/messages'
import type { AppDatabase } from '../db/database'

// 「智能 · 自动审核」记录的持久层（core 域拥有）：running → passed/rejected/error 全程留痕，供 UI 展示。

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

export class AutoReviewRepo {
  private readonly db: DatabaseSync

  constructor(database: AppDatabase) {
    this.db = database.db
  }

  /** 建一条自动审核记录（status = running），供进度展示 */
  create(input: {
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
  finish(
    id: number,
    status: Exclude<AutoReviewStatus, 'running'>,
    reason: string | null,
    decidedTs: number,
  ): AutoReviewRecord | null {
    this.db
      .prepare('UPDATE auto_reviews SET status = ?, reason = ?, decided_ts = ? WHERE id = ?')
      .run(status, reason, decidedTs, id)
    return this.get(id)
  }

  get(id: number): AutoReviewRecord | null {
    const row = this.db.prepare('SELECT * FROM auto_reviews WHERE id = ?').get(id) as unknown as
      AutoReviewRow | undefined
    return row === undefined ? null : rowToAutoReview(row)
  }

  /** 最近的自动审核记录（新 → 旧） */
  list(limit = 50): AutoReviewRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM auto_reviews ORDER BY id DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 200)) as unknown as AutoReviewRow[]
    return rows.map(rowToAutoReview)
  }
}
