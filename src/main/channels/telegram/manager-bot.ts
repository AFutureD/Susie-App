import type { ManagerBotConfig } from '../../../shared/config'
import { encodeChatId, decodeChatId } from '../../../shared/chat-id'
import { errorMessage } from '../../../shared/errors'
import type { ChannelStatus, ChatMessage, InboundEnvelope, MessagePart } from '../../../shared/messages'
import type { ConfigRef } from '../../config/store'
import { botCopy } from '../../copy/bot-copy'
import { sleep } from '../../util/async'
import { Backoff } from '../../util/backoff'
import type { Logger } from '../../util/logger'
import { isHtmlEntityError } from './bot'
import {
  BotApiError,
  callBotApi,
  getMeRaw,
  tgDisplayName,
  type TgManagedBotUpdated,
  type TgRawMessage,
  type TgUpdate,
} from './bot-api'
import { renderMessageHtml, renderMessagePlain } from './render'
import type { Channel, InlineButton } from '../types'

// Manager bot 的 raw 长轮询器（渠道管理，不是渠道，不进 ChannelHub）：
// - 只订阅 message + managed_bot 两类 update；managed_bot 交 ManagedBotRegistry；
// - 私聊消息经 onMessage 上抛只为 record-only 入历史（owner 绑定的 senders 候选），
//   会话循环在 ChatManager 按 manager_bots 命中短路；
// - 无 drop_pending：离线积压的创建事件正是价值所在。
// 实现 Channel 接口是为了 service.getChannel 的 fallback（history 页 composer 可发消息），
// 生命周期由 ManagedBotRegistry 编排（存在即运行，token 变更重启，删除即停）。

/** can_manage_bots 未开启时的重查间隔 / 409 重试间隔 / 退避参数（测试可注入缩短） */
export interface ManagerBotTimings {
  manageModeRecheckMs: number
  conflictRetryMs: number
  backoffBaseMs: number
  backoffCapMs: number
}

const DEFAULT_TIMINGS: ManagerBotTimings = {
  manageModeRecheckMs: 60_000,
  conflictRetryMs: 30_000,
  backoffBaseMs: 1_000,
  backoffCapMs: 30_000,
}

export interface TelegramManagerBotDeps {
  id: string
  /** 读穿引用：managing 列表变更不需要重启，token 变更由 registry 重启实例 */
  settingsRef: ConfigRef<ManagerBotConfig>
  onMessage: (envelope: InboundEnvelope) => void
  /** managed_bot update 的领域出口（registry 判定轮换 / 登记发现） */
  onManagedBotUpdate: (managerId: string, managerToken: string, ev: TgManagedBotUpdated) => void
  onStatus: (status: ChannelStatus) => void
  log: Logger
  timings?: Partial<ManagerBotTimings>
}

export class TelegramManagerBotChannel implements Channel {
  readonly id: string
  private readonly deps: TelegramManagerBotDeps
  private readonly timings: ManagerBotTimings
  private readonly backoff: Backoff
  private state: ChannelStatus
  private running = false
  private abort = new AbortController()
  private loopDone: Promise<void> | null = null
  private meId: number | null = null
  private meUsername: string | null = null

  constructor(deps: TelegramManagerBotDeps) {
    this.id = deps.id
    this.deps = deps
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings }
    this.backoff = new Backoff(this.timings.backoffBaseMs, this.timings.backoffCapMs)
    this.state = { id: deps.id, state: 'stopped', detail: null }
  }

  status(): ChannelStatus {
    return this.state
  }

  private setStatus(state: ChannelStatus['state'], detail: string | null = null): void {
    // 状态未变不重发：离线时轮询每次失败都会调到这里，重复广播只是 IPC 噪音
    if (this.state.state === state && this.state.detail === detail) return
    this.state = { id: this.id, state, detail }
    if (state === 'error') {
      this.deps.log.error(`manager ${this.id}: ${detail ?? 'error'}`)
    }
    this.deps.onStatus(this.state)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.abort = new AbortController()
    this.setStatus('starting')
    this.loopDone = this.runLoop().catch((error: unknown) => {
      if (this.running) this.setStatus('error', `轮询循环异常退出：${errorMessage(error)}`)
    })
  }

  async stop(): Promise<void> {
    this.running = false
    this.abort.abort()
    await (this.loopDone ?? Promise.resolve())
    this.loopDone = null
    this.setStatus('stopped')
  }

  private token(): string | null {
    return this.deps.settingsRef.current?.token ?? null
  }

  private async runLoop(): Promise<void> {
    // 阶段一：getMe 校验，直到确认管理模式（未开启不是终态——用户去 BotFather 开启后自愈）
    while (this.running) {
      const token = this.token()
      if (token === null) return
      try {
        const me = await getMeRaw(token, this.abort.signal)
        if (me.can_manage_bots !== true) {
          this.setStatus('error', '未开启 Bot Management Mode——在 BotFather 的 bot 设置中开启后自动恢复')
          await this.sleep(this.timings.manageModeRecheckMs)
          continue
        }
        this.meId = me.id
        this.meUsername = me.username ?? null
        break
      } catch (error) {
        if (!this.running) return
        if (error instanceof BotApiError && (error.code === 401 || error.code === 404)) {
          // 不是终态：BotFather revoke 后重新启用同 token 时低频重查可自愈；换 token 仍由 registry 重启
          this.setStatus('error', `token 校验失败：${error.message}`)
          await this.sleep(this.timings.manageModeRecheckMs)
          continue
        }
        this.setStatus('error', `getMe 失败：${errorMessage(error)}`)
        await this.sleep(this.backoff.next())
      }
    }
    if (!this.running) return
    this.backoff.reset()
    this.setStatus('running', this.meUsername === null ? null : `@${this.meUsername}`)

    // 阶段二：getUpdates 长轮询（首轮不带 offset：收下离线积压）
    let offset: number | undefined
    while (this.running) {
      const token = this.token()
      if (token === null) return
      try {
        const updates = await callBotApi<TgUpdate[]>(
          token,
          'getUpdates',
          {
            timeout: 50,
            allowed_updates: ['message', 'managed_bot'],
            ...(offset === undefined ? {} : { offset }),
          },
          { timeoutMs: 65_000, signal: this.abort.signal },
        )
        this.backoff.reset()
        if (this.state.state !== 'running') {
          this.setStatus('running', this.meUsername === null ? null : `@${this.meUsername}`)
        }
        for (const update of updates) {
          // 先推进 offset：单条处理异常不能卡死队列
          offset = update.update_id + 1
          try {
            this.handleUpdate(update, token)
          } catch (error) {
            this.deps.log.error(`manager ${this.id}: update 处理失败：${errorMessage(error)}`)
          }
        }
      } catch (error) {
        if (!this.running) return
        if (error instanceof BotApiError) {
          if (error.code === 401 || error.code === 404) {
            // 同阶段一：低频重试而非终态，token 重新启用后下一轮 getUpdates 自然复验
            this.setStatus('error', `token 已失效：${error.message}`)
            await this.sleep(this.timings.manageModeRecheckMs)
            continue
          }
          if (error.code === 409) {
            this.setStatus('error', '409 Conflict：该 token 正被其他进程轮询')
            await this.sleep(this.timings.conflictRetryMs)
            continue
          }
          if (error.code === 429) {
            await this.sleep((error.retryAfter ?? 5) * 1000)
            continue
          }
        }
        this.setStatus('error', `polling 错误：${errorMessage(error)}`)
        await this.sleep(this.backoff.next())
      }
    }
  }

  private handleUpdate(update: TgUpdate, token: string): void {
    if (update.managed_bot !== undefined) {
      this.deps.onManagedBotUpdate(this.id, token, update.managed_bot)
      return
    }
    const message = update.message
    if (message === undefined) return
    // 只关心私聊真人消息：sender 入历史库 = owner 绑定候选；群/频道一律忽略
    if (message.chat.type !== 'private') return
    if (message.from === undefined || message.from.is_bot) return

    const text = message.text ?? message.caption ?? ''
    if ((message.text ?? message.caption) === undefined) {
      this.deps.log.info(`manager ${this.id}: 私聊非文本消息，附件不下载（record-only 只需 sender 出现）`)
    }
    this.deps.onMessage({
      message: this.buildChatMessage(message, text),
      chatName: tgDisplayName(message.from),
      mentioned: false,
      threadAnchorMessageId: null,
    })

    if (/^\/start(\s|$|@)/.test(text)) {
      void this.replyStart(token, message.chat.id)
    }
  }

  private buildChatMessage(message: TgRawMessage, text: string): ChatMessage {
    return {
      id: String(message.message_id),
      channelId: this.id,
      chatId: encodeChatId('private', message.chat.id),
      receiver: null,
      replyTo: null,
      out: false,
      sender: tgDisplayName(message.from),
      senderId: message.from === undefined ? null : String(message.from.id),
      timestamp: message.date * 1000,
      parts: text === '' ? [] : [{ kind: 'text', text }],
    }
  }

  /** /start 直接回提示（会话循环已短路，不会有 assistant 响应）；回复本身也走 onMessage 入历史 */
  private async replyStart(token: string, rawChatId: number): Promise<void> {
    try {
      const sent = await callBotApi<TgRawMessage>(
        token,
        'sendMessage',
        { chat_id: rawChatId, text: botCopy.manager.startReply },
        { timeoutMs: 15_000, signal: this.abort.signal },
      )
      this.deps.onMessage({
        message: {
          id: String(sent.message_id),
          channelId: this.id,
          chatId: encodeChatId('private', rawChatId),
          receiver: null,
          replyTo: null,
          out: true,
          sender: this.meUsername,
          senderId: this.meId === null ? null : String(this.meId),
          timestamp: sent.date * 1000,
          parts: [{ kind: 'text', text: botCopy.manager.startReply }],
        },
        chatName: null,
        mentioned: false,
        threadAnchorMessageId: null,
      })
    } catch (error) {
      this.deps.log.error(`manager ${this.id}: /start 回复失败：${errorMessage(error)}`)
    }
  }

  // ---------- Channel 接口其余方法（service.getChannel fallback 用） ----------

  /** 最小纯文本发送（history 页 composer）；file part 跳过并留日志 */
  async sendMessage(message: ChatMessage, _options: { buttons?: InlineButton[][] } = {}): Promise<ChatMessage> {
    const token = this.token()
    if (token === null) throw new Error(`manager 配置不存在：${this.id}`)
    const target = decodeChatId(message.chatId)
    if (target === null) throw new Error(`无法解析 chat_id：${message.chatId}`)

    const skipped = message.parts.filter((part) => part.kind !== 'text').length
    if (skipped > 0) this.deps.log.info(`manager ${this.id}: 跳过 ${skipped} 个非文本 part（manager 只发文本）`)
    const textParts: MessagePart[] = message.parts.filter((part) => part.kind === 'text')
    if (textParts.length === 0) throw new Error('manager 只支持发送文本消息')

    let sent: TgRawMessage
    try {
      sent = await callBotApi<TgRawMessage>(
        token,
        'sendMessage',
        { chat_id: target.rawChatId, text: renderMessageHtml(textParts), parse_mode: 'HTML' },
        { timeoutMs: 15_000 },
      )
    } catch (error) {
      if (!isHtmlEntityError(error)) throw error
      // HTML 实体问题降级纯文本（与 bot.ts 同款策略）
      sent = await callBotApi<TgRawMessage>(
        token,
        'sendMessage',
        { chat_id: target.rawChatId, text: renderMessagePlain(textParts) },
        { timeoutMs: 15_000 },
      )
    }
    return { ...message, id: String(sent.message_id), out: true, timestamp: sent.date * 1000 }
  }

  async editMessage(): Promise<void> {
    // manager 不发卡片，无编辑场景
  }

  async answerCallback(): Promise<void> {
    // manager 无 inline 按钮
  }

  directChatId(userId: string): string | null {
    return encodeChatId('private', userId)
  }

  beginTyping(): () => void {
    return () => {}
  }

  async refreshCommandMenus(): Promise<void> {
    // manager 不注册命令菜单
  }

  /** 可中断睡眠：stop() 的 abort 立即唤醒 */
  private sleep(ms: number): Promise<void> {
    return sleep(ms, this.abort.signal)
  }
}
