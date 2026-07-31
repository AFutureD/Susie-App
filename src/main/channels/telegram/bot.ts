import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import TelegramBot, {
  type BotCommand,
  type BotCommandScope,
  type Chat,
  type InlineKeyboardMarkup,
  type Message,
  type User,
} from 'node-telegram-bot-api'
import type { TelegramBotChannelSettings } from '../../../shared/config'
import type { ChannelStatus, ChatMessage, InboundEnvelope, MessagePart } from '../../../shared/messages'
import type { ConfigRef } from '../../config/store'
import type { CommandSpec } from '../../core/commands'
import { withDeadline, withTimeout } from '../../util/async'
import type { Logger } from '../../util/logger'
import { decodeChatId, encodeChatId, type DecodedChatId } from '../../../shared/chat-id'
import { resolveTelegramChatId, signalsFromCallbackSource, signalsFromMessage } from './chat-id'
import { renderMessageHtml, renderMessagePlain } from './render'
import type { Channel, ChannelCallbackEvent, InlineButton } from '../types'

type SendMessageForm = NonNullable<Parameters<TelegramBot['sendMessage']>[2]>
type SendDocumentForm = NonNullable<Parameters<TelegramBot['sendDocument']>[2]>
type SendChatActionForm = NonNullable<Parameters<TelegramBot['sendChatAction']>[2]>

export interface TelegramBotChannelDeps {
  id: string
  /** 读穿引用：白名单/群策略等热更新即刻生效 */
  settingsRef: ConfigRef<TelegramBotChannelSettings>
  attachmentsDir: string
  /** 命令菜单（Bot API setMyCommands）名单，启动时注册 */
  listCommands: () => CommandSpec[]
  /** 可执行需审核命令的用户（owner + 私聊直通档）telegram user id——其私聊注册完整命令菜单 */
  listPrivilegedUserIds: () => string[]
  onMessage: (envelope: InboundEnvelope) => void
  onCallback: (event: ChannelCallbackEvent) => void
  onStatus: (status: ChannelStatus) => void
  log: Logger
}

/** Bot API 对命令的硬性约束：名称 1-32 位小写字母/数字/下划线，描述 1-256 字符 */
export function toBotCommands(specs: CommandSpec[]): BotCommand[] {
  return specs
    .filter((spec) => /^[a-z0-9_]{1,32}$/.test(spec.name))
    .map((spec) => ({
      command: spec.name,
      description: (spec.description === '' ? spec.name : spec.description).slice(0, 256),
    }))
}

function displayName(user: User | undefined): string | null {
  if (user === undefined) return null
  const name = [user.first_name, user.last_name].filter((x) => x !== undefined && x !== '').join(' ')
  return name !== '' ? name : (user.username ?? String(user.id))
}

function chatTitle(chat: Chat): string | null {
  if (chat.title !== undefined) return chat.title
  const full = [chat.first_name, chat.last_name].filter((x) => x !== undefined && x !== '').join(' ')
  if (full !== '') return full
  return chat.username ?? null
}

/** 按钮行列 → Bot API inline keyboard */
export function toInlineKeyboard(buttons: InlineButton[][]): InlineKeyboardMarkup {
  return {
    inline_keyboard: buttons.map((row) => row.map((button) => ({ text: button.label, callback_data: button.id }))),
  }
}

export class TelegramBotChannel implements Channel {
  readonly id: string
  private readonly deps: TelegramBotChannelDeps
  private bot: TelegramBot | null = null
  private meId: number | null = null
  private meUsername: string | null = null
  private state: ChannelStatus

  constructor(deps: TelegramBotChannelDeps) {
    this.id = deps.id
    this.deps = deps
    this.state = { id: deps.id, state: 'stopped', detail: null }
  }

  status(): ChannelStatus {
    return this.state
  }

  private setStatus(state: ChannelStatus['state'], detail: string | null = null): void {
    const prev = this.state
    this.state = { id: this.id, state, detail }
    // 状态徽标只在 UI 上；error 状态必须同时留日志（按状态转变去重，防 polling 重试刷屏）
    if (state === 'error' && (prev.state !== 'error' || prev.detail !== detail)) {
      this.deps.log.error(`channel ${this.id}: ${detail ?? 'error'}`)
    }
    this.deps.onStatus(this.state)
  }

  async start(): Promise<void> {
    const settings = this.deps.settingsRef.current
    if (settings === undefined) throw new Error(`channel 配置不存在：${this.id}`)

    this.setStatus('starting')
    const bot = new TelegramBot(settings.token, { polling: false })
    this.bot = bot

    try {
      // 网络被墙/黑洞时请求可能长挂，必须有 deadline
      const me = await withDeadline(bot.getMe(), 15_000, 'getMe')
      this.meId = me.id
      this.meUsername = me.username ?? null
    } catch (error) {
      this.setStatus('error', `token 校验失败：${describeTelegramError(error)}`)
      this.bot = null
      return
    }
    if (this.bot !== bot) return // 等待期间被 stop()

    // 命令菜单注册不阻塞启动，失败只留日志
    void this.registerBotCommands(bot)

    if (settings.drop_pending_updates) {
      try {
        const pending = await bot.getUpdates({ offset: -1, limit: 1, timeout: 0 })
        const last = pending.at(-1)
        if (last !== undefined) {
          await bot.getUpdates({ offset: last.update_id + 1, limit: 1, timeout: 0 })
        }
      } catch (error) {
        // 丢弃积压失败不阻塞启动
        this.deps.log.info(
          `channel ${this.id}: 丢弃积压消息失败（不影响启动）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    bot.on('message', (message) => {
      try {
        this.handleInbound(message)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.deps.log.error(`channel ${this.id}: 入站处理异常，消息被丢弃：${detail}`)
        this.setStatus('running', `入站处理异常：${detail}`)
      }
    })

    // broadcast channel 的贴文走独立事件（library 层与 'message' 互斥分发）。
    // 只把 channel 消息喂进历史与 UI，不参与命令响应/绑定/权限——由 ChatManager 侧短路
    // （chatType==='channel' 只 record + 广播）。
    bot.on('channel_post', (message) => {
      try {
        this.handleInbound(message)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.deps.log.error(`channel ${this.id}: 频道贴文处理异常，消息被丢弃：${detail}`)
        this.setStatus('running', `频道贴文处理异常：${detail}`)
      }
    })

    // inline 按钮点击（审核卡片等）。注意：drop_pending_updates 开启时，
    // 应用离线期间的点击会随积压更新一并丢弃——卡片按钮仍在，点按者重按即可。
    bot.on('callback_query', (query) => {
      try {
        if (this.deps.settingsRef.current === undefined) return
        // 卡片超过 48h 后回调里的 message 退化为 InaccessibleMessage（缺 is_topic_message / thread id）→
        // resolver 一律回退基础会话；Forum Topic 内的旧按钮可能因此进入不同 Susie 会话。
        const source = query.message
        const signals = signalsFromCallbackSource(source)
        // channel 里的按钮点击不参与 bot 会话循环（审核卡片只发到私聊/群，channel 场景本无来源）
        if (signals?.chatType === 'channel') {
          this.deps.log.info(`channel ${this.id}: 忽略 channel 内的按钮回调（chat=${signals.rawChatId}）`)
          return
        }
        const resolved = signals === null ? null : resolveTelegramChatId(signals)
        this.deps.onCallback({
          channelId: this.id,
          callbackQueryId: query.id,
          fromId: String(query.from.id),
          data: query.data ?? '',
          chatId: resolved === null || resolved.chatId === '' ? null : resolved.chatId,
          messageId: source === undefined ? null : String(source.message_id),
        })
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.deps.log.error(`channel ${this.id}: 按钮回调处理异常：${detail}`)
      }
    })

    bot.on('polling_error', (error) => {
      const text = describeTelegramError(error)
      if (text.includes('409')) {
        this.setStatus('error', '409 Conflict：该 token 正被其他进程轮询（老的 Python susie 还在跑？）')
      } else {
        this.setStatus('error', `polling 错误：${text}`)
      }
    })

    await bot.startPolling()
    this.setStatus('running', `@${this.meUsername ?? '?'}`)
  }

  private async registerBotCommands(bot: TelegramBot): Promise<void> {
    const specs = this.deps.listCommands()
    const commands = toBotCommands(specs)
    if (commands.length < specs.length) {
      this.deps.log.info(
        `channel ${this.id}: ${specs.length - commands.length} 个命令名不符合 Telegram 规则（[a-z0-9_]{1,32}），未注册进菜单`,
      )
    }
    if (commands.length === 0) return

    // 默认菜单只含免审命令（无权限用户看不到需审核命令）；有权限的私聊按 chat scope 注册完整菜单
    const publicCommands = toBotCommands(specs.filter((spec) => spec.gated === false))
    try {
      await withDeadline(bot.setMyCommands(publicCommands), 15_000, 'setMyCommands')
    } catch (error) {
      // 菜单注册失败不影响收发消息，命令仍可手动输入
      this.deps.log.error(`channel ${this.id}: 命令菜单注册失败：${describeTelegramError(error)}`)
      return
    }

    for (const userId of this.deps.listPrivilegedUserIds()) {
      if (!/^\d+$/.test(userId)) continue
      // node-telegram-bot-api 不会自动序列化嵌套的 scope 对象，需手动 JSON.stringify
      const scope = JSON.stringify({ type: 'chat', chat_id: Number(userId) }) as unknown as BotCommandScope
      try {
        // oxlint-disable-next-line no-await-in-loop -- 按序注册，避免打爆 Bot API 限速
        await withDeadline(bot.setMyCommands(commands, { scope }), 15_000, 'setMyCommands(chat)')
      } catch (error) {
        // 用户从未私聊过 bot 时该 scope 会 400；等其私聊后 refreshCommandMenus 再补
        this.deps.log.info(
          `channel ${this.id}: 私聊 ${userId} 的完整命令菜单注册失败（可能尚未私聊过 bot）：${describeTelegramError(error)}`,
        )
      }
    }
  }

  /** 权限名单变化后重新同步命令菜单 */
  async refreshCommandMenus(): Promise<void> {
    const bot = this.bot
    if (bot === null) return
    await this.registerBotCommands(bot)
  }

  async stop(): Promise<void> {
    const bot = this.bot
    this.bot = null
    if (bot !== null) {
      try {
        // 停机不允许被网络请求拖住
        await withTimeout(
          bot.stopPolling().then(() => undefined),
          3000,
          undefined,
        )
      } catch {
        // 忽略停机竞态
      }
      bot.removeAllListeners()
    }
    this.setStatus('stopped')
  }

  /** 处理期间维持“正在输入”提示；返回停止函数 */
  /** Telegram 私聊 chat.id == user id（onboarding 从私聊发送者选 owner，保证该私聊存在） */
  directChatId(userId: string): string | null {
    return encodeChatId('private', userId)
  }

  beginTyping(chatId: string): () => void {
    const bot = this.bot
    const decoded = decodeChatId(chatId)
    if (bot === null || decoded === null) return () => {}

    const form: SendChatActionForm = {}
    if (decoded.threadId !== null) form.message_thread_id = decoded.threadId

    const send = () => {
      void bot.sendChatAction(decoded.rawChatId, 'typing', form).catch(() => {})
    }
    send()
    const timer = setInterval(send, 4500)
    return () => clearInterval(timer)
  }

  async sendMessage(message: ChatMessage, options: { buttons?: InlineButton[][] } = {}): Promise<ChatMessage> {
    const bot = this.bot
    if (bot === null) throw new Error(`通道未运行：${this.id}`)

    const target = decodeChatId(message.receiver ?? message.chatId)
    if (target === null) throw new Error(`无法解析 chat_id：${message.receiver ?? message.chatId}`)

    const replyToId = message.replyTo !== null && /^\d+$/.test(message.replyTo) ? Number(message.replyTo) : null

    const base: SendMessageForm = {}
    if (target.threadId !== null) base.message_thread_id = target.threadId
    // reply_parameters 允许原消息删除时投递到基础会话（普通线程 fallback 也不会因原消息消失而失败）
    if (replyToId !== null) {
      base.reply_parameters = { message_id: replyToId, allow_sending_without_reply: true }
    }
    if (options.buttons !== undefined && options.buttons.length > 0) {
      base.reply_markup = toInlineKeyboard(options.buttons)
    }

    let sentId: string | null = null
    const html = renderMessageHtml(message.parts)
    if (html !== '') {
      let sent: Message
      try {
        sent = await bot.sendMessage(target.rawChatId, html, { ...base, parse_mode: 'HTML' })
      } catch (error) {
        // 只对可判定的 HTML 实体/解析错误做纯文本重试；Topic、权限、未知错误一律直接失败
        if (!isHtmlEntityError(error)) throw error
        this.deps.log.info(
          `channel ${this.id}: HTML 渲染被 Telegram 拒绝，降级纯文本重发：${error instanceof Error ? error.message : String(error)}`,
        )
        sent = await bot.sendMessage(target.rawChatId, renderMessagePlain(message.parts), base)
      }
      this.verifyOutboundThread(target, sent)
      sentId = String(sent.message_id)
    }

    for (const part of message.parts) {
      if (part.kind !== 'file') continue
      if (!fs.existsSync(part.path)) continue
      const form: SendDocumentForm = {}
      if (target.threadId !== null) form.message_thread_id = target.threadId
      // oxlint-disable-next-line no-await-in-loop -- 附件按序发送，保持消息顺序
      const sent = await bot.sendDocument(target.rawChatId, part.path, form)
      this.verifyOutboundThread(target, sent)
      sentId = sentId ?? String(sent.message_id)
    }

    return { ...message, id: sentId, timestamp: Date.now() }
  }

  /**
   * Topic 出站回执校验：
   * - supergroup + 目标 threadId：sent.message_thread_id 明确不匹配（含缺失）一律抛错，绝不静默降级；
   * - 私聊：Bot API 9.3 起可能带 direct_messages_topic 语义，回执字段形状待冒烟确认——只告警，不失败。
   */
  private verifyOutboundThread(target: DecodedChatId, sent: Message): void {
    if (target.threadId === null) return
    const gotThread = sent.message_thread_id ?? null
    if (gotThread === target.threadId) return
    if (target.chatType === 'private') {
      this.deps.log.info(
        `channel ${this.id}: 私聊 Topic 出站回执 thread 缺失（期望 ${target.threadId}，收到 ${gotThread === null ? 'null' : gotThread}）——暂告警，待真实冒烟确认`,
      )
      return
    }
    throw new Error(
      `Topic 出站失败：期望 message_thread_id=${target.threadId}，收到 ${gotThread === null ? 'null' : gotThread}`,
    )
  }

  /** 应答 inline 按钮点击（Telegram 要求必须应答，否则点按者客户端转圈 ~30s）；失败仅留日志 */
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    const bot = this.bot
    if (bot === null) return
    try {
      await bot.answerCallbackQuery(callbackQueryId, text === undefined ? {} : { text })
    } catch (error) {
      // 过期的 callback query 会 400，不影响业务状态
      this.deps.log.info(
        `channel ${this.id}: answerCallbackQuery 失败（query 可能已过期）：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /** 编辑已发消息（审核卡片决定后更新文案/撤按钮）；编辑失败不致命，仅留日志 */
  async editMessage(
    chatId: string,
    messageId: string,
    parts: MessagePart[],
    buttons: InlineButton[][] | null,
  ): Promise<void> {
    const bot = this.bot
    if (bot === null) return
    const target = decodeChatId(chatId)
    if (target === null || !/^\d+$/.test(messageId)) return

    const form = {
      chat_id: target.rawChatId,
      message_id: Number(messageId),
      reply_markup: toInlineKeyboard(buttons ?? []),
    }
    try {
      await bot.editMessageText(renderMessageHtml(parts), { ...form, parse_mode: 'HTML' })
    } catch {
      try {
        // HTML 实体问题降级为纯文本（与 sendMessage 同款策略）
        await bot.editMessageText(renderMessagePlain(parts), form)
      } catch (error) {
        this.deps.log.error(
          `channel ${this.id}: 编辑消息失败（chat=${chatId}, msg=${messageId}）：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  private handleInbound(message: Message): void {
    // topic 创建事件与 topic 首条标题消息忽略（对位 Python 逻辑）
    if (message.forum_topic_created !== undefined) {
      this.deps.log.info(`channel ${this.id}: 忽略 topic 创建事件（chat=${message.chat.id}）`)
      return
    }
    if (
      message.reply_to_message?.forum_topic_created !== undefined &&
      message.reply_to_message.forum_topic_created.name === message.text
    ) {
      this.deps.log.info(`channel ${this.id}: 忽略 topic 标题回显消息（chat=${message.chat.id}）`)
      return
    }

    if (this.deps.settingsRef.current === undefined) {
      this.deps.log.info(`channel ${this.id}: 配置已不存在，入站消息被丢弃（chat=${message.chat.id}）`)
      return
    }

    // 硬性规则：bot / 匿名发送者不触发（准入策略本身由 ChatManager 按会话绑定判定）。
    // broadcast channel 的贴文 message.from 天然 undefined（只有 sender_chat），
    // 这类消息仍应进历史；ChatManager 会按 chatType 短路，绝不进入命令/绑定/权限流。
    const from = message.from
    const isChannelPost = message.chat.type === 'channel'
    if (!isChannelPost && (from === undefined || from.is_bot)) {
      this.deps.log.info(`channel ${this.id}: 忽略 bot/匿名发送者的消息（chat=${message.chat.id}）`)
      return
    }

    const signals = signalsFromMessage(message)
    const resolved = resolveTelegramChatId(signals)
    if (resolved.chatId === '') {
      this.deps.log.info(
        `channel ${this.id}: 不支持的 chat 类型 "${message.chat.type}"（chat=${message.chat.id}），消息忽略`,
      )
      return
    }
    // 普通线程（有 thread 但 canonical 未保留第三段）→ 记录锚点，后续回复走 reply_parameters 保回复位
    const threadAnchorMessageId = signals.threadId !== null && !resolved.isTopic ? String(message.message_id) : null

    void this.buildChatMessage(message, resolved.chatId)
      .then((chatMessage) => {
        this.deps.onMessage({
          message: chatMessage,
          chatName: chatTitle(message.chat),
          mentioned: this.isMentioned(message),
          threadAnchorMessageId,
        })
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        this.deps.log.error(`channel ${this.id}: 入站消息构建失败，消息被丢弃：${detail}`)
        this.setStatus('running', `入站处理异常：${detail}`)
      })
  }

  private async buildChatMessage(message: Message, chatId: string): Promise<ChatMessage> {
    const parts: ChatMessage['parts'] = []
    const text = message.text ?? message.caption ?? ''
    if (text !== '') parts.push({ kind: 'text', text })

    // 图片：取最大尺寸下载
    if (message.photo !== undefined && message.photo.length > 0) {
      const largest = [...message.photo].toSorted((a, b) => a.width * a.height - b.width * b.height).at(-1)
      if (largest !== undefined) {
        const filePath = await this.download(largest.file_id, 'photos')
        if (filePath !== null) parts.push({ kind: 'file', path: filePath })
      }
    }

    // 语音：下载 .oga；系统装有 ffmpeg 则转 wav
    if (message.voice !== undefined) {
      const ogaPath = await this.download(message.voice.file_id, 'voices')
      if (ogaPath !== null) {
        const converted = convertVoiceIfPossible(ogaPath)
        parts.push({ kind: 'file', path: converted ?? ogaPath })
        if (converted === null) {
          this.deps.log.info(`channel ${this.id}: ffmpeg 不可用，语音未转 wav，按原始 oga 传给 agent`)
          parts.push({ kind: 'text', text: '(voice message attached)' })
        }
      }
    }

    if (message.document !== undefined) {
      const filePath = await this.download(message.document.file_id, 'documents')
      if (filePath !== null) parts.push({ kind: 'file', path: filePath })
    }

    // channel 贴文没有 message.from，用 sender_chat / chat.title 兜底展示；senderId 保持 null
    // （历史/权限侧靠 senderId 是否为 user id 做判定）。
    return {
      id: String(message.message_id),
      channelId: this.id,
      chatId,
      receiver: null,
      replyTo: message.reply_to_message === undefined ? null : String(message.reply_to_message.message_id),
      out: this.meId !== null && message.from?.id === this.meId,
      sender: displayName(message.from) ?? chatTitle(message.sender_chat ?? message.chat),
      senderId: message.from === undefined ? null : String(message.from.id),
      timestamp: message.date * 1000,
      parts,
    }
  }

  private async download(fileId: string, kind: string): Promise<string | null> {
    const bot = this.bot
    if (bot === null) return null
    try {
      const dir = path.join(this.deps.attachmentsDir, kind)
      fs.mkdirSync(dir, { recursive: true })
      return await bot.downloadFile(fileId, dir)
    } catch (error) {
      // 附件丢失后消息仍会继续处理，agent 看不到该文件——必须留痕
      this.deps.log.error(
        `channel ${this.id}: 附件下载失败（${kind}, file_id=${fileId}），消息将缺少该附件：${error instanceof Error ? error.message : String(error)}`,
      )
      return null
    }
  }

  private isMentioned(message: Message): boolean {
    // 回复了 bot 的消息
    if (this.meId !== null && message.reply_to_message?.from?.id === this.meId) return true

    const username = this.meUsername
    if (username === null) return false

    const text = message.text ?? message.caption ?? ''
    const entities = message.entities ?? message.caption_entities ?? []
    for (const entity of entities) {
      if (entity.type === 'mention') {
        const mention = text.slice(entity.offset, entity.offset + entity.length)
        if (mention.replace(/^@/, '').toLowerCase() === username.toLowerCase()) return true
      }
      if (entity.type === 'text_mention' && entity.user?.username?.toLowerCase() === username.toLowerCase()) {
        return true
      }
    }
    return false
  }
}

function describeTelegramError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * HTML → 纯文本重试白名单。仅 Telegram 明确报告的实体/解析错误才降级重试；
 * Topic 权限（TOPIC_CLOSED / MESSAGE_THREAD_INVALID）、发送权限（Forbidden / ChatWriteForbidden）
 * 及未知错误一律直接失败——绝不静默去掉 message_thread_id 重发。
 */
export function isHtmlEntityError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    text.includes("can't parse entities") ||
    text.includes('unsupported start tag') ||
    text.includes("can't find end tag")
  )
}

/** 系统 ffmpeg 存在时把 OGG/Opus 转 wav（不捆绑 ffmpeg，保持包体轻） */
function convertVoiceIfPossible(ogaPath: string): string | null {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  if (probe.error !== undefined || probe.status !== 0) return null

  const wavPath = ogaPath.replace(/\.[^.]+$/, '.wav')
  if (fs.existsSync(wavPath)) return wavPath

  const result = spawnSync('ffmpeg', ['-y', '-i', ogaPath, '-ar', '16000', '-ac', '1', wavPath], { stdio: 'ignore' })
  return result.status === 0 && fs.existsSync(wavPath) ? wavPath : null
}
