import type { DatabaseSync } from 'node:sqlite'
import type { InboundEnvelope } from '../../shared/messages'
import type { AppDatabase } from '../db/database'

// member 消息审核暂存的持久层（core 域拥有；与对话历史同库不同表）。
// 重启后 Telegram 卡片按钮仍要可用，故整个 InboundEnvelope JSON 落库。

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

export class ApprovalRepo {
  private readonly db: DatabaseSync

  constructor(database: AppDatabase) {
    this.db = database.db
  }

  create(input: {
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

  get(id: number): PendingApproval | null {
    const row = this.db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as unknown as
      PendingApprovalRow | undefined
    if (row === undefined) return null
    return rowToPendingApproval(row)
  }

  /** 记录审核卡片位置（发送成功后回填，用于事后编辑卡片） */
  setCard(id: number, cardChatId: string, cardMsgId: string | null): void {
    this.db
      .prepare('UPDATE pending_approvals SET card_chat_id = ?, card_msg_id = ? WHERE id = ?')
      .run(cardChatId, cardMsgId, id)
  }

  /**
   * 原子认领：仅 from 态（默认 pending）可迁移到目标态。返回 false = 已被处理
   * （owner 双击按钮 / 重启后 Telegram 重放回调的去重依据）。
   */
  claim(
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
  reopen(id: number, autoReviewReason: string | null): boolean {
    const result = this.db
      .prepare(
        `UPDATE pending_approvals SET status = 'pending', auto_review_reason = ?
         WHERE id = ? AND status = 'auto_reviewing'`,
      )
      .run(autoReviewReason, id)
    return Number(result.changes) === 1
  }

  /** 未决审核（老 → 新）；envelope 损坏的行跳过 */
  listPending(channelId?: string): PendingApproval[] {
    const rows = (channelId === undefined
      ? this.db.prepare(`SELECT * FROM pending_approvals WHERE status = 'pending' ORDER BY id`).all()
      : this.db
          .prepare(`SELECT * FROM pending_approvals WHERE status = 'pending' AND channel_id = ? ORDER BY id`)
          .all(channelId)) as unknown as PendingApprovalRow[]
    return rows.map(rowToPendingApproval).filter((row) => row !== null)
  }
}
