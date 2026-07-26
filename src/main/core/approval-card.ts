import { partsToPlainText, type MessagePart } from '../../shared/messages'
import { botCopy } from '../copy/bot-copy'
import type { PendingApproval } from './approval-repo'

// 审核卡片模型 → MessagePart[] 的唯一渲染函数（通道中立：MessagePart[] 是跨平台表现货币，
// 平台化渲染（Telegram HTML 等）由各通道的 render 层完成）。文案一律取自 copy/bot-copy.ts。

/** 卡片引用的消息正文截断长度 */
const CARD_TEXT_LIMIT = 500

/** 审核卡片正文（状态行按 pending.status 渲染；裁决后重建同一份并追加裁决行，避免另存卡片文案） */
export function buildCardParts(pending: PendingApproval, decision?: string): MessagePart[] {
  const copy = botCopy.approval
  const { envelope } = pending
  const sender = pending.sender ?? pending.senderId ?? copy.unknownSender
  const chatLabel = envelope.chatName ?? pending.chatId
  const text = partsToPlainText(envelope.message.parts)
  const clipped = text.length > CARD_TEXT_LIMIT ? `${text.slice(0, CARD_TEXT_LIMIT)}…` : text
  const files = envelope.message.parts.filter((part) => part.kind === 'file').length

  const lines = [copy.cardHeader(copy.statusTag[pending.status], sender, chatLabel)]
  if (clipped !== '') lines.push(clipped)
  if (files > 0) lines.push(copy.fileCount(files))
  if (pending.status === 'auto_reviewing') {
    lines.push('', copy.autoReviewing)
  } else if (pending.status === 'auto_passed' || pending.status === 'terminated') {
    lines.push('', copy.autoPassedLine)
  } else if (pending.autoReviewReason !== null) {
    lines.push('', copy.autoRejectedLine(pending.autoReviewReason))
  }
  if (decision !== undefined) lines.push('', decision)
  return [{ kind: 'text', text: lines.join('\n') }]
}
