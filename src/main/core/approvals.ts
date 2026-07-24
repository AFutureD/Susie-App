import { resolveBinding } from '../../shared/bindings'
import { encodeChatId } from '../../shared/chat-id'
import {
  partsToPlainText,
  type ChatMessage,
  type InboundEnvelope,
  type MessagePart,
  type StoredMessage,
} from '../../shared/messages'
import { channelOwner } from '../../shared/users'
import type { ChannelCallbackEvent, InlineButton, TelegramBotChannel } from '../channels/telegram-bot'
import type { ConfigStore } from '../config/store'
import type { HistoryStore, PendingApproval } from '../history/store'
import type { Logger } from '../util/logger'

// member 消息审核流：暂存 → owner 私聊卡片（允许/拒绝按钮）→ 回调裁决 → 重放或丢弃。
// 暂存持久化在 history 库（pending_approvals），重启后卡片按钮仍可用。

/** callback_data 形态：apv:<pendingId>:<allow|deny>（Bot API 限 ≤64 字节） */
const CALLBACK_PATTERN = /^apv:(\d+):(allow|deny)$/
/** 卡片引用的消息正文截断长度 */
const CARD_TEXT_LIMIT = 500

const MEMBER_PENDING_NOTICE = '⏳ 消息已提交 owner 审核。'
const MEMBER_DENIED_NOTICE = '🚫 消息未获 owner 批准。'
const MEMBER_UNDELIVERABLE_NOTICE = 'Error: 审核请求发送失败（owner 不可达），消息未处理。'

export interface ApprovalManagerDeps {
  store: ConfigStore
  history: HistoryStore
  getChannel: (id: string) => TelegramBotChannel | undefined
  /** owner 批准后的重放（ChatManager.handleApproved，经每会话串行队列） */
  dispatchApproved: (pending: PendingApproval) => void
  onHistoryMessage: (message: StoredMessage) => void
  log: Logger
}

/** 审核卡片正文（决定后重建同一份并追加裁决行，避免另存卡片文案） */
export function buildCardParts(pending: PendingApproval, decision?: string): MessagePart[] {
  const { envelope } = pending
  const sender = pending.sender ?? pending.senderId ?? '未知用户'
  const chatLabel = envelope.chatName ?? pending.chatId
  const text = partsToPlainText(envelope.message.parts)
  const clipped = text.length > CARD_TEXT_LIMIT ? `${text.slice(0, CARD_TEXT_LIMIT)}…` : text
  const files = envelope.message.parts.filter((part) => part.kind === 'file').length

  const lines = [`【待审核】${sender} 在「${chatLabel}」发来消息：`]
  if (clipped !== '') lines.push(clipped)
  if (files > 0) lines.push(`（含 ${files} 个附件）`)
  if (decision !== undefined) lines.push('', decision)
  return [{ kind: 'text', text: lines.join('\n') }]
}

function approvalButtons(pendingId: number): InlineButton[][] {
  return [
    [
      { id: `apv:${pendingId}:allow`, label: '允许' },
      { id: `apv:${pendingId}:deny`, label: '拒绝' },
    ],
  ]
}

export class ApprovalManager {
  private readonly deps: ApprovalManagerDeps

  constructor(deps: ApprovalManagerDeps) {
    this.deps = deps
  }

  /** 暂存 member 消息并向 owner 私聊发送审核卡片；本方法不抛异常（失败落 failed + 日志） */
  async request(envelope: InboundEnvelope): Promise<void> {
    const { message } = envelope
    const channelId = message.channelId

    const owner = channelOwner(this.deps.store.current.users, channelId)
    if (owner === null) {
      // 角色门已拦截无 owner 的情况；到这里说明请求与配置变更竞争，放弃即可
      this.deps.log.error(`approval: 频道 ${channelId} 无 owner，审核请求被丢弃`)
      return
    }

    const pending = this.deps.history.createPendingApproval({
      channelId,
      chatId: message.chatId,
      senderId: message.senderId,
      sender: message.sender,
      envelope,
      createdTs: Date.now(),
    })

    const channel = this.deps.getChannel(channelId)
    if (channel === undefined) {
      this.deps.history.claimPendingApproval(pending.id, 'failed', Date.now())
      this.deps.log.error(`approval#${pending.id}: 通道 ${channelId} 未运行，审核卡片无法发送`)
      return
    }

    // owner 私聊 chat id 可直接由 user id 构造（telegram 私聊 chat.id == user id）；
    // onboarding 从私聊发送者里选 owner，保证该私聊存在、卡片可送达
    const ownerChatId = encodeChatId('private', owner.user_id)
    try {
      const sent = await channel.sendMessage(
        {
          id: null,
          channelId,
          chatId: ownerChatId,
          receiver: null,
          replyTo: null,
          out: true,
          sender: 'susie',
          senderId: null,
          timestamp: Date.now(),
          parts: buildCardParts(pending),
        },
        { buttons: approvalButtons(pending.id) },
      )
      const stored = this.deps.history.record(sent, owner.name ?? null)
      this.deps.onHistoryMessage(stored)
      this.deps.history.setPendingApprovalCard(pending.id, ownerChatId, sent.id)
      this.deps.log.info(`approval#${pending.id}: 审核卡片已发送至 owner（${channelId}/${ownerChatId}）`)
    } catch (error) {
      this.deps.history.claimPendingApproval(pending.id, 'failed', Date.now())
      this.deps.log.error(
        `approval#${pending.id}: 审核卡片发送失败（owner 可能从未私聊过 bot）：${error instanceof Error ? error.message : String(error)}`,
      )
      await this.notifyChat(channelId, message.chatId, MEMBER_UNDELIVERABLE_NOTICE, message.id)
      return
    }

    await this.notifyChat(channelId, message.chatId, MEMBER_PENDING_NOTICE, message.id)
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
    const action = match[2] as 'allow' | 'deny'

    const pending = this.deps.history.getPendingApproval(pendingId)
    if (pending === null || pending.channelId !== event.channelId) {
      await channel.answerCallback(event.callbackQueryId, '该审核请求不存在或已失效')
      return
    }

    // 按当前配置校验点按者身份（卡片发出后 owner 交接过也以现任为准）
    const owner = channelOwner(this.deps.store.current.users, pending.channelId)
    if (owner === null || event.fromId !== owner.user_id) {
      await channel.answerCallback(event.callbackQueryId, '仅 owner 可操作')
      return
    }

    if (action === 'deny') {
      // 原子认领：双击/重启重放只有第一次生效
      if (!this.deps.history.claimPendingApproval(pending.id, 'denied', Date.now())) {
        await channel.answerCallback(event.callbackQueryId, '已处理')
        return
      }
      await this.editCard(channel, pending, '🚫 已拒绝')
      await channel.answerCallback(event.callbackQueryId, '已拒绝')
      await this.notifyChat(pending.channelId, pending.chatId, MEMBER_DENIED_NOTICE, pending.envelope.message.id)
      this.deps.log.info(`approval#${pending.id}: owner 已拒绝`)
      return
    }

    // allow：先预检绑定仍有效（失效则不重放，卡片注明），再认领与分发
    const binding = resolveBinding(this.deps.store.current.bindings, pending.channelId, pending.chatId)
    const assistantExists =
      binding !== null && this.deps.store.current.assistants.some((a) => a.id === binding.assistant_id)
    if (binding === null || !assistantExists) {
      if (this.deps.history.claimPendingApproval(pending.id, 'failed', Date.now())) {
        await this.editCard(channel, pending, '⚠️ 绑定已失效，未执行')
      }
      await channel.answerCallback(event.callbackQueryId, '绑定已失效，未执行')
      this.deps.log.error(`approval#${pending.id}: 批准时绑定/assistant 已失效，未重放`)
      return
    }

    if (!this.deps.history.claimPendingApproval(pending.id, 'approved', Date.now())) {
      await channel.answerCallback(event.callbackQueryId, '已处理')
      return
    }
    await this.editCard(channel, pending, '✅ 已允许')
    await channel.answerCallback(event.callbackQueryId, '已允许')
    this.deps.log.info(`approval#${pending.id}: owner 已批准，消息重放处理`)
    this.deps.dispatchApproved(pending)
  }

  /** 决定后更新卡片（重建文案 + 追加裁决行 + 撤按钮）；失败不致命 */
  private async editCard(channel: TelegramBotChannel, pending: PendingApproval, decision: string): Promise<void> {
    if (pending.cardChatId === null || pending.cardMsgId === null) return
    await channel.editMessage(pending.cardChatId, pending.cardMsgId, buildCardParts(pending, decision), null)
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
      const stored = this.deps.history.record(sent)
      this.deps.onHistoryMessage(stored)
    } catch (error) {
      this.deps.log.error(
        `approval: 会话通知发送失败（${channelId}/${chatId}）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
