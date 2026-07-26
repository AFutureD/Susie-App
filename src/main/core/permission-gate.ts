import { channelOwner, permissionFor } from '../../shared/users'
import type { ChatMessage, InboundEnvelope } from '../../shared/messages'
import type { ConfigStore } from '../config/store'
import { botCopy } from '../copy/bot-copy'
import type { Logger } from '../util/logger'
import type { PendingApproval } from './approval-repo'
import type { AutoReviewVerdict } from './auto-review'

// 身份门：ignore / review / auto / allow 四档 × 免审命令 × 自动审核编排的判定矩阵。
// 从 ChatManager.process() 抽出的唯一结构性组件——可脱离会话编排独立单测。

/**
 * 门结论（取代曾经纠缠的 preapproved / gatedAllowed / autoPassed / exemptCommand 四布尔）：
 * - pass    直通（owner / allow 档 / 批准重放 / 自动审核通过）；命令按完整权限执行
 * - exempt  免审命令放行（review/auto 档执行免审命令）；help 隐藏需审核命令
 * - handled 已终结：ignore 已反馈 / 已转人工卡片 / auto 拒绝已 settle / 无 owner 已提示
 */
export type GateDecision = { kind: 'pass' } | { kind: 'exempt' } | { kind: 'handled' }

export interface GateInput {
  envelope: InboundEnvelope
  message: ChatMessage
  key: string
  chatType: string | null
  command: { name: string } | null
}

export interface PermissionGateDeps {
  store: ConfigStore
  /** 命令权限分类（未注册命令视为需审核，交回 assistant 按普通消息管控） */
  isCommandGated: (name: string) => boolean
  /** member 消息转 owner 审核（暂存 + 发卡片；不等待审核结果） */
  requestApproval: (envelope: InboundEnvelope, options?: { autoReviewReason?: string | null }) => Promise<void>
  /** 自动审核档：评估消息是否放行 */
  autoReview: (envelope: InboundEnvelope) => Promise<AutoReviewVerdict>
  /** auto 档：审核前发「自动审核中」进度卡片；无 owner/发送失败返回 null（审核照常） */
  beginAutoReview: (envelope: InboundEnvelope) => Promise<PendingApproval | null>
  /** auto 档：结论落卡片（通过→终止按钮；拒绝→转人工 + member 通知） */
  settleAutoReview: (pending: PendingApproval, verdict: AutoReviewVerdict) => Promise<void>
  /** 会话内反馈（被拦下的发送者要知道原因） */
  reply: (source: ChatMessage, text: string) => Promise<void>
  log: Logger
}

export class PermissionGate {
  constructor(private readonly deps: PermissionGateDeps) {}

  async evaluate(input: GateInput): Promise<GateDecision> {
    const { message, envelope, chatType, command, key } = input
    const users = this.deps.store.current.users
    const permission = permissionFor(users, message.channelId, message.senderId, message.chatId, chatType)

    if (permission === 'ignore') {
      this.deps.log.info(`chat ${key} 发送者 ${message.senderId ?? '?'} 在该范围为忽略档，不响应`)
      await this.deps.reply(message, botCopy.gate.permissionIgnored)
      return { kind: 'handled' }
    }
    if (permission !== 'review' && permission !== 'auto') return { kind: 'pass' }

    // 免审命令（help / chat_id / new）：审核/自动档用户也直接执行；忽略档不豁免（显式拉黑强于免审）
    if (command !== null && !this.deps.isCommandGated(command.name)) {
      this.deps.log.info(`chat ${key} 免审命令 /${command.name}：${permission} 档发送者直接执行`)
      return { kind: 'exempt' }
    }

    // 自动档：先发「审核中」进度卡片（尽力而为），再跑自动审核。
    // 通过 → 卡片更新为可终止（急停），放行处理；未通过 → 卡片转人工（附拒绝原因）。
    let autoReviewReason: string | null = null
    if (permission === 'auto') {
      const card = await this.deps.beginAutoReview(envelope)
      const verdict = await this.deps.autoReview(envelope)
      if (verdict.passed) {
        this.deps.log.info(`chat ${key} 发送者 ${message.senderId ?? '?'} 自动审核通过，放行`)
        if (card !== null) await this.deps.settleAutoReview(card, verdict)
        return { kind: 'pass' }
      }
      autoReviewReason = verdict.reason
      this.deps.log.info(
        `chat ${key} 发送者 ${message.senderId ?? '?'} 自动审核未通过（${verdict.reason ?? '无理由'}），回落人工审核`,
      )
      if (card !== null) {
        // 卡片就位：settle 负责转人工（原因 + 允许/拒绝按钮 + member 通知），不再另发卡片
        await this.deps.settleAutoReview(card, verdict)
        return { kind: 'handled' }
      }
    }

    // 无 owner 检查只挡「转人工」路径（auto 通过的消息在上方已放行）
    if (channelOwner(users, message.channelId) === null) {
      this.deps.log.info(`chat ${key} 需审核但频道未绑定 owner，无人可审，不响应`)
      await this.deps.reply(message, botCopy.gate.noOwner)
      return { kind: 'handled' }
    }
    this.deps.log.info(`chat ${key} 发送者 ${message.senderId ?? '?'} 转 owner 审核`)
    await this.deps.requestApproval(envelope, { autoReviewReason })
    return { kind: 'handled' }
  }
}
