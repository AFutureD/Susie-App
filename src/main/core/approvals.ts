import { resolveBinding } from '../../shared/bindings'
import type { ChatMessage, InboundEnvelope, StoredMessage } from '../../shared/messages'
import { channelOwner, defaultUser, findUser, upsertUser } from '../../shared/users'
import type { Channel, ChannelCallbackEvent, InlineButton } from '../channels/types'
import { botCopy } from '../copy/bot-copy'
import { buildCardParts } from './approval-card'
import type { ConfigStore } from '../config/store'
import type { MessageRepo } from '../history/message-repo'
import type { Logger } from '../util/logger'
import type { ApprovalRepo, PendingApproval } from './approval-repo'

// member 消息审核流：暂存 → owner 私聊卡片 → 回调裁决 → 重放或丢弃。
// 暂存持久化在应用库（pending_approvals，ApprovalRepo），重启后卡片按钮仍可用。
//
// 两条入口：
// - review 档：request() 建 pending 卡片（允许/拒绝按钮），owner 裁决。
// - auto 档：beginAutoReview() 先发「审核中」卡片（无按钮）→ settleAutoReview() 落结论：
//   通过 → auto_passed，卡片换「终止」按钮（误判急停，中断 agent 处理）；
//   拒绝 → 转 pending，卡片附拒绝原因并给出允许/拒绝按钮（owner 可推翻）。

/** callback_data 形态：apv:<pendingId>:<allow|deny|stop>（Bot API 限 ≤64 字节） */
const CALLBACK_PATTERN = /^apv:(\d+):(allow|deny|stop)$/

const COPY = botCopy.approval

export interface ApprovalManagerDeps {
  store: ConfigStore
  approvals: ApprovalRepo
  messages: MessageRepo
  getChannel: (id: string) => Channel | undefined
  /** owner 批准后的重放（ChatManager.handleApproved，经每会话串行队列） */
  dispatchApproved: (pending: PendingApproval) => void
  /** owner 急停（终止按钮）：取消该会话当前活跃 agent turn；返回是否命中活跃会话 */
  terminateChat: (pending: PendingApproval) => Promise<boolean>
  onHistoryMessage: (message: StoredMessage) => void
  log: Logger
}

function approvalButtons(pendingId: number): InlineButton[][] {
  return [
    [
      { id: `apv:${pendingId}:allow`, label: COPY.action.allow },
      { id: `apv:${pendingId}:deny`, label: COPY.action.deny },
    ],
  ]
}

/** 自动审核通过后的急停按钮（防误判：消息已放行，owner 可中断 agent 处理） */
function terminateButtons(pendingId: number): InlineButton[][] {
  return [[{ id: `apv:${pendingId}:stop`, label: COPY.action.stop }]]
}

export class ApprovalManager {
  private readonly deps: ApprovalManagerDeps

  constructor(deps: ApprovalManagerDeps) {
    this.deps = deps
  }

  /** 暂存 member 消息并向 owner 私聊发送审核卡片；本方法不抛异常（失败落 failed + 日志） */
  async request(envelope: InboundEnvelope, options: { autoReviewReason?: string | null } = {}): Promise<void> {
    const { message } = envelope
    const channelId = message.channelId

    const owner = channelOwner(this.deps.store.current.users, channelId)
    if (owner === null) {
      // 角色门已拦截无 owner 的情况；到这里说明请求与配置变更竞争，放弃即可
      this.deps.log.error(`approval: 频道 ${channelId} 无 owner，审核请求被丢弃`)
      return
    }

    const pending = this.deps.approvals.create({
      channelId,
      chatId: message.chatId,
      senderId: message.senderId,
      sender: message.sender,
      envelope,
      createdTs: Date.now(),
      autoReviewReason: options.autoReviewReason ?? null,
    })

    const sent = await this.sendCard(pending, owner.user_id, owner.name ?? null, approvalButtons(pending.id))
    if (!sent) {
      await this.notifyChat(channelId, message.chatId, COPY.memberUndeliverable, message.id)
      return
    }
    await this.notifyChat(channelId, message.chatId, COPY.memberPending, message.id)
  }

  /**
   * auto 档：审核开始前发「🤖 自动审核中…」卡片（无按钮），供 owner 实时看到进度。
   * 卡片是尽力而为：无 owner / 通道未运行 / 发送失败都返回 null，自动审核照常进行
   * （拒绝时由调用方回落 request() 再试一次人工卡片）。
   */
  async beginAutoReview(envelope: InboundEnvelope): Promise<PendingApproval | null> {
    const { message } = envelope
    const channelId = message.channelId

    const owner = channelOwner(this.deps.store.current.users, channelId)
    if (owner === null) {
      this.deps.log.info(`approval: 频道 ${channelId} 无 owner，自动审核卡片跳过`)
      return null
    }

    const pending = this.deps.approvals.create({
      channelId,
      chatId: message.chatId,
      senderId: message.senderId,
      sender: message.sender,
      envelope,
      createdTs: Date.now(),
      status: 'auto_reviewing',
    })

    const sent = await this.sendCard(pending, owner.user_id, owner.name ?? null, undefined)
    if (!sent) return null
    return this.deps.approvals.get(pending.id)
  }

  /**
   * auto 档结论落卡片：
   * - 通过：auto_reviewing → auto_passed，卡片换「终止」按钮（消息已放行，owner 可急停）；
   * - 拒绝：auto_reviewing → pending 转人工，卡片附拒绝原因 + 允许/拒绝按钮，member 收 ⏳ 通知。
   */
  async settleAutoReview(pending: PendingApproval, verdict: { passed: boolean; reason: string | null }): Promise<void> {
    const channel = this.deps.getChannel(pending.channelId)
    if (verdict.passed) {
      if (!this.deps.approvals.claim(pending.id, 'auto_passed', Date.now(), 'auto_reviewing')) {
        this.deps.log.error(`approval#${pending.id}: 自动审核通过落状态失败（已被处理？）`)
        return
      }
      if (channel !== undefined) {
        await this.editCard(channel, { ...pending, status: 'auto_passed' }, undefined, terminateButtons(pending.id))
      }
      this.deps.log.info(`approval#${pending.id}: 自动审核通过，卡片已更新（可终止）`)
      return
    }

    if (!this.deps.approvals.reopen(pending.id, verdict.reason)) {
      this.deps.log.error(`approval#${pending.id}: 自动审核拒绝转人工失败（已被处理？）`)
      return
    }
    if (channel !== undefined) {
      await this.editCard(
        channel,
        { ...pending, status: 'pending', autoReviewReason: verdict.reason },
        undefined,
        approvalButtons(pending.id),
      )
    }
    this.deps.log.info(`approval#${pending.id}: 自动审核未通过（${verdict.reason ?? '无理由'}），已转人工审核`)
    await this.notifyChat(pending.channelId, pending.chatId, COPY.memberPending, pending.envelope.message.id)
  }

  /** 发送审核卡片至 owner 私聊并回填卡片位置；失败 claim failed（返回 false），不抛异常 */
  private async sendCard(
    pending: PendingApproval,
    ownerUserId: string,
    ownerName: string | null,
    buttons: InlineButton[][] | undefined,
  ): Promise<boolean> {
    const channel = this.deps.getChannel(pending.channelId)
    if (channel === undefined) {
      this.deps.approvals.claim(pending.id, 'failed', Date.now(), pending.status)
      this.deps.log.error(`approval#${pending.id}: 通道 ${pending.channelId} 未运行，审核卡片无法发送`)
      return false
    }

    // owner 私聊会话 id 由通道构造（Telegram：私聊 chat.id == user id）；
    // onboarding 从私聊发送者里选 owner，保证该私聊存在、卡片可送达
    const ownerChatId = channel.directChatId(ownerUserId)
    if (ownerChatId === null) {
      this.deps.approvals.claim(pending.id, 'failed', Date.now(), pending.status)
      this.deps.log.error(`approval#${pending.id}: 通道 ${pending.channelId} 无法构造 owner 私聊会话，审核卡片无法发送`)
      return false
    }
    try {
      const sent = await channel.sendMessage(
        {
          id: null,
          channelId: pending.channelId,
          chatId: ownerChatId,
          receiver: null,
          replyTo: null,
          out: true,
          sender: 'susie',
          senderId: null,
          timestamp: Date.now(),
          parts: buildCardParts(pending),
        },
        buttons === undefined ? {} : { buttons },
      )
      const stored = this.deps.messages.record(sent, ownerName)
      this.deps.onHistoryMessage(stored)
      this.deps.approvals.setCard(pending.id, ownerChatId, sent.id)
      this.deps.log.info(`approval#${pending.id}: 审核卡片已发送至 owner（${pending.channelId}/${ownerChatId}）`)
      return true
    } catch (error) {
      this.deps.approvals.claim(pending.id, 'failed', Date.now(), pending.status)
      this.deps.log.error(
        `approval#${pending.id}: 审核卡片发送失败（owner 可能从未私聊过 bot）：${error instanceof Error ? error.message : String(error)}`,
      )
      return false
    }
  }

  /** inline 按钮回调裁决。所有分支都必须应答 callback（否则点按者客户端一直转圈）。 */
  async handleCallback(event: ChannelCallbackEvent): Promise<void> {
    const channel = this.deps.getChannel(event.channelId)
    if (channel === undefined) return

    const match = CALLBACK_PATTERN.exec(event.data)
    if (match === null) {
      // 未知按钮：仅清除点按者客户端的等待态
      await channel.answerCallback(event.callbackQueryId)
      return
    }
    const pendingId = Number(match[1])
    const action = match[2] as 'allow' | 'deny' | 'stop'

    const pending = this.deps.approvals.get(pendingId)
    if (pending === null || pending.channelId !== event.channelId) {
      await channel.answerCallback(event.callbackQueryId, COPY.callbackToast.missing)
      return
    }

    // 按当前配置校验点按者身份（卡片发出后 owner 交接过也以现任为准）
    const owner = channelOwner(this.deps.store.current.users, pending.channelId)
    if (owner === null || event.fromId !== owner.user_id) {
      await channel.answerCallback(event.callbackQueryId, COPY.callbackToast.ownerOnly)
      return
    }

    if (action === 'stop') {
      // 急停：仅自动审核放行态可终止（原子认领防双击）
      if (!this.deps.approvals.claim(pending.id, 'terminated', Date.now(), 'auto_passed')) {
        await channel.answerCallback(event.callbackQueryId, COPY.callbackToast.handled)
        return
      }
      const cancelled = await this.deps.terminateChat(pending)
      const decision = cancelled ? COPY.decision.terminatedActive : COPY.decision.terminatedIdle
      await this.editCard(channel, { ...pending, status: 'terminated' }, decision)
      await channel.answerCallback(event.callbackQueryId, COPY.callbackToast.terminated)
      this.deps.log.info(`approval#${pending.id}: owner 已终止（活跃任务${cancelled ? '已中断' : '不存在'}）`)
      return
    }

    if (action === 'deny') {
      // 原子认领：双击/重启重放只有第一次生效
      if (!this.deps.approvals.claim(pending.id, 'denied', Date.now())) {
        await channel.answerCallback(event.callbackQueryId, COPY.callbackToast.handled)
        return
      }
      await this.editCard(channel, { ...pending, status: 'denied' }, COPY.decision.denied)
      await channel.answerCallback(event.callbackQueryId, COPY.callbackToast.denied)
      await this.notifyChat(pending.channelId, pending.chatId, COPY.memberDenied, pending.envelope.message.id)
      this.deps.log.info(`approval#${pending.id}: owner 已拒绝`)
      return
    }

    // allow：先预检绑定仍有效（失效则不重放，卡片注明），再认领与分发
    const binding = resolveBinding(this.deps.store.current.bindings, pending.channelId, pending.chatId)
    const assistantExists =
      binding !== null && this.deps.store.current.assistants.some((a) => a.id === binding.assistant_id)
    if (binding === null || !assistantExists) {
      if (this.deps.approvals.claim(pending.id, 'failed', Date.now())) {
        await this.editCard(channel, { ...pending, status: 'failed' }, COPY.decision.bindingGone)
      }
      await channel.answerCallback(event.callbackQueryId, COPY.callbackToast.bindingGone)
      this.deps.log.error(`approval#${pending.id}: 批准时绑定/assistant 已失效，未重放`)
      return
    }

    if (!this.deps.approvals.claim(pending.id, 'approved', Date.now())) {
      await channel.answerCallback(event.callbackQueryId, COPY.callbackToast.handled)
      return
    }
    await this.editCard(channel, { ...pending, status: 'approved' }, COPY.decision.approved)
    await channel.answerCallback(event.callbackQueryId, COPY.callbackToast.approved)
    this.deps.log.info(`approval#${pending.id}: owner 已批准，消息重放处理`)
    this.registerApprovedSender(pending)
    this.deps.dispatchApproved(pending)
  }

  /** 批准即入册：陌生发送者按缺省档位登记（带显示名），owner 之后可在用户页调整档位 */
  private registerApprovedSender(pending: PendingApproval): void {
    if (pending.senderId === null) return
    const users = this.deps.store.current.users
    if (findUser(users, pending.channelId, pending.senderId) !== null) return
    const result = this.deps.store.setUsers(
      upsertUser(users, defaultUser(pending.channelId, pending.senderId, pending.sender)),
      this.deps.store.currentVersion,
    )
    if (result.ok) {
      this.deps.log.info(`approval#${pending.id}: 发送者 ${pending.senderId} 已自动登记（缺省审核档）`)
    } else {
      // 极小概率与 UI 编辑撞版本；不影响本次重放，下次批准会再尝试
      this.deps.log.error(`approval#${pending.id}: 发送者自动登记失败：${result.message}`)
    }
  }

  /** 更新卡片（按状态重建文案，可追加裁决行）；buttons 缺省 null = 撤按钮；失败不致命 */
  private async editCard(
    channel: Channel,
    pending: PendingApproval,
    decision?: string,
    buttons: InlineButton[][] | null = null,
  ): Promise<void> {
    if (pending.cardChatId === null || pending.cardMsgId === null) return
    await channel.editMessage(pending.cardChatId, pending.cardMsgId, buildCardParts(pending, decision), buttons)
  }

  /** 尽力而为的会话通知（member 等待/拒绝反馈）；失败仅日志 */
  private async notifyChat(channelId: string, chatId: string, text: string, replyTo: string | null): Promise<void> {
    const channel = this.deps.getChannel(channelId)
    if (channel === undefined) return
    const message: ChatMessage = {
      id: null,
      channelId,
      chatId,
      receiver: null,
      replyTo,
      out: true,
      sender: 'susie',
      senderId: null,
      timestamp: Date.now(),
      parts: [{ kind: 'text', text }],
    }
    try {
      const sent = await channel.sendMessage(message)
      const stored = this.deps.messages.record(sent)
      this.deps.onHistoryMessage(stored)
    } catch (error) {
      this.deps.log.error(
        `approval: 会话通知发送失败（${channelId}/${chatId}）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
