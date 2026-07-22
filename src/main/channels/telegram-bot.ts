import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import TelegramBot, { type Chat, type Message, type User } from 'node-telegram-bot-api'
import type { TelegramBotChannelSettings } from '../../shared/config'
import type { ChannelStatus, ChatMessage } from '../../shared/messages'
import type { ConfigRef } from '../config/store'
import { withDeadline, withTimeout } from '../util/async'
import { decodeChatId, encodeChatId } from './chat-id'
import { isInboundAllowed } from './telegram-policy'
import { renderMessageHtml, renderMessagePlain } from './telegram-render'

type SendMessageForm = NonNullable<Parameters<TelegramBot['sendMessage']>[2]>
type SendDocumentForm = NonNullable<Parameters<TelegramBot['sendDocument']>[2]>
type SendChatActionForm = NonNullable<Parameters<TelegramBot['sendChatAction']>[2]>

export interface InboundEnvelope {
  message: ChatMessage
  chatName: string | null
}

export interface TelegramBotChannelDeps {
  id: string
  /** 读穿引用：白名单/群策略等热更新即刻生效 */
  settingsRef: ConfigRef<TelegramBotChannelSettings>
  attachmentsDir: string
  onMessage: (envelope: InboundEnvelope) => void
  onStatus: (status: ChannelStatus) => void
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

export class TelegramBotChannel {
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
    this.state = { id: this.id, state, detail }
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

    if (settings.drop_pending_updates) {
      try {
        const pending = await bot.getUpdates({ offset: -1, limit: 1, timeout: 0 })
        const last = pending.at(-1)
        if (last !== undefined) {
          await bot.getUpdates({ offset: last.update_id + 1, limit: 1, timeout: 0 })
        }
      } catch {
        // 丢弃积压失败不阻塞启动
      }
    }

    bot.on('message', (message) => {
      try {
        this.handleInbound(message)
      } catch (error) {
        this.setStatus('running', `入站处理异常：${error instanceof Error ? error.message : String(error)}`)
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

  async sendMessage(message: ChatMessage): Promise<ChatMessage> {
    const bot = this.bot
    if (bot === null) throw new Error(`通道未运行：${this.id}`)

    const target = decodeChatId(message.receiver ?? message.chatId)
    if (target === null) throw new Error(`无法解析 chat_id：${message.receiver ?? message.chatId}`)

    const replyToId = message.replyTo !== null && /^\d+$/.test(message.replyTo) ? Number(message.replyTo) : null

    const base: SendMessageForm = {}
    if (target.threadId !== null) base.message_thread_id = target.threadId
    if (replyToId !== null) base.reply_parameters = { message_id: replyToId }

    let sentId: string | null = null
    const html = renderMessageHtml(message.parts)
    if (html !== '') {
      try {
        const sent = await bot.sendMessage(target.rawChatId, html, { ...base, parse_mode: 'HTML' })
        sentId = String(sent.message_id)
      } catch {
        // HTML 实体问题降级为纯文本
        const sent = await bot.sendMessage(target.rawChatId, renderMessagePlain(message.parts), base)
        sentId = String(sent.message_id)
      }
    }

    for (const part of message.parts) {
      if (part.kind !== 'file') continue
      if (!fs.existsSync(part.path)) continue
      const form: SendDocumentForm = {}
      if (target.threadId !== null) form.message_thread_id = target.threadId
      // oxlint-disable-next-line no-await-in-loop -- 附件按序发送，保持消息顺序
      const sent = await bot.sendDocument(target.rawChatId, part.path, form)
      sentId = sentId ?? String(sent.message_id)
    }

    return { ...message, id: sentId, timestamp: Date.now() }
  }

  private handleInbound(message: Message): void {
    // topic 创建事件与 topic 首条标题消息忽略（对位 Python 逻辑）
    if (message.forum_topic_created !== undefined) return
    if (
      message.reply_to_message?.forum_topic_created !== undefined &&
      message.reply_to_message.forum_topic_created.name === message.text
    ) {
      return
    }

    const settings = this.deps.settingsRef.current
    if (settings === undefined) return

    const from = message.from
    const allowed = isInboundAllowed(settings, {
      fromBot: from?.is_bot ?? true,
      userId: from === undefined ? null : String(from.id),
      chatType: message.chat.type,
      rawChatId: String(message.chat.id),
      mentioned: this.isMentioned(message),
    })
    if (!allowed) return

    const chatId = encodeChatId(message.chat.type, message.chat.id, message.message_thread_id ?? null)
    if (chatId === '') return

    void this.buildChatMessage(message, chatId).then((chatMessage) => {
      this.deps.onMessage({ message: chatMessage, chatName: chatTitle(message.chat) })
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
        if (converted === null) parts.push({ kind: 'text', text: '(voice message attached)' })
      }
    }

    if (message.document !== undefined) {
      const filePath = await this.download(message.document.file_id, 'documents')
      if (filePath !== null) parts.push({ kind: 'file', path: filePath })
    }

    return {
      id: String(message.message_id),
      channelId: this.id,
      chatId,
      receiver: null,
      replyTo: message.reply_to_message === undefined ? null : String(message.reply_to_message.message_id),
      out: this.meId !== null && message.from?.id === this.meId,
      sender: displayName(message.from),
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
    } catch {
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

/** 系统 ffmpeg 存在时把 OGG/Opus 转 wav（不捆绑 ffmpeg，保持包体轻） */
function convertVoiceIfPossible(ogaPath: string): string | null {
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  if (probe.error !== undefined || probe.status !== 0) return null

  const wavPath = ogaPath.replace(/\.[^.]+$/, '.wav')
  if (fs.existsSync(wavPath)) return wavPath

  const result = spawnSync('ffmpeg', ['-y', '-i', ogaPath, '-ar', '16000', '-ac', '1', wavPath], { stdio: 'ignore' })
  return result.status === 0 && fs.existsSync(wavPath) ? wavPath : null
}
