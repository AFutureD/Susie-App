import { CHAT_ALL, DEFAULT_ASSISTANT_ID, type AssistantConfig, type ChatBinding } from '../../shared/config'
import {
  partsToPlainText,
  partsToPromptText,
  type ChatMessage,
  type MessagePart,
  type StoredMessage,
} from '../../shared/messages'
import type { AgentRuntime } from '../agents/types'
import type { InboundEnvelope, TelegramBotChannel } from '../channels/telegram-bot'
import type { ConfigStore, Unsubscribe } from '../config/store'
import type { HistoryStore } from '../history/store'
import { renderPrompt, renderSystemInstruction } from '../replier/templates'
import type { Logger } from '../util/logger'
import { CommandRegistry, parseCommandText, type CommandContext } from './commands'

/** 自己在别的客户端亲自回复后，忽略该会话新消息的时长（对位 Python IGNORE_MESSAGE_DURATION） */
const IGNORE_AFTER_SELF_REPLY_MS = 120_000

/** binding 解析：按声明顺序，单次遍历，命中精确 chat_id 或 "*"（对位 Python get_binding） */
export function resolveBinding(bindings: ChatBinding[], channelId: string, chatId: string): ChatBinding {
  for (const binding of bindings) {
    if (binding.channel !== channelId) continue
    if (binding.chat_ids.includes(chatId)) return binding
    if (binding.chat_ids.includes(CHAT_ALL)) return binding
  }
  return { channel: channelId, chat_ids: [CHAT_ALL], assistant_id: DEFAULT_ASSISTANT_ID }
}

interface ChatEntry {
  key: string
  channelId: string
  chatId: string
  assistantId: string
  runtime: AgentRuntime
  registry: CommandRegistry
  ignoreUntil: number
  unsubs: Unsubscribe[]
}

export interface ChatManagerDeps {
  store: ConfigStore
  history: HistoryStore
  mcpName: string
  getChannel: (id: string) => TelegramBotChannel | undefined
  createRuntime: (assistant: AssistantConfig) => Promise<AgentRuntime>
  onHistoryMessage: (message: StoredMessage) => void
  log: Logger
}

export class ChatManager {
  private readonly deps: ChatManagerDeps
  private readonly chats = new Map<string, ChatEntry>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly globalRegistry = new CommandRegistry()
  private readonly unsubs: Unsubscribe[] = []

  constructor(deps: ChatManagerDeps) {
    this.deps = deps
    // binding 变化 → 全部会话下次消息时按新 binding 重建
    this.unsubs.push(
      deps.store.subscribePath('bindings', () => {
        this.deps.log.info('bindings 变更：所有会话失效，下条消息按新绑定重建')
        this.disposeAll()
      }),
    )
  }

  /** 通道入站回调 */
  handleInbound(envelope: InboundEnvelope): void {
    const { message, chatName } = envelope
    const stored = this.deps.history.record(message, chatName)
    this.deps.onHistoryMessage(stored)

    const key = chatKey(message.channelId, message.chatId)

    if (message.out) {
      // 自己亲自回复了：闭嘴两分钟并取消进行中的 turn
      const entry = this.chats.get(key)
      if (entry !== undefined) {
        this.deps.log.info(
          `chat ${key} 检测到本人亲自回复：${IGNORE_AFTER_SELF_REPLY_MS / 1000}s 内不再自动响应，进行中的 turn 已取消`,
        )
        entry.ignoreUntil = Date.now() + IGNORE_AFTER_SELF_REPLY_MS
        void entry.runtime.cancel()
      }
      return
    }

    this.enqueue(key, () => this.process(message))
  }

  /** UI composer / MCP send_message 出站入口 */
  async sendMessage(input: {
    channelId: string
    chatId: string
    parts: MessagePart[]
    receiver?: string | null
    replyTo?: string | null
  }): Promise<StoredMessage> {
    const channel = this.deps.getChannel(input.channelId)
    if (channel === undefined) throw new Error(`通道未运行：${input.channelId}`)

    const message: ChatMessage = {
      id: null,
      channelId: input.channelId,
      chatId: input.chatId,
      receiver: input.receiver ?? null,
      replyTo: input.replyTo ?? null,
      out: true,
      sender: 'susie',
      timestamp: Date.now(),
      parts: input.parts,
    }
    const sent = await channel.sendMessage(message)
    const stored = this.deps.history.record(sent)
    this.deps.onHistoryMessage(stored)
    return stored
  }

  onChannelRemoved(channelId: string): void {
    for (const entry of Array.from(this.chats.values())) {
      if (entry.channelId === channelId) this.disposeChat(entry.key)
    }
  }

  disposeAll(): void {
    for (const key of Array.from(this.chats.keys())) this.disposeChat(key)
  }

  // ---------- 内部 ----------

  private enqueue(key: string, fn: () => Promise<void>): void {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(fn).catch((error: unknown) => {
      this.deps.log.error(`chat ${key} 处理失败：${error instanceof Error ? error.message : String(error)}`)
    })
    this.queues.set(key, next)
  }

  private async process(message: ChatMessage): Promise<void> {
    const key = chatKey(message.channelId, message.chatId)

    let entry: ChatEntry
    try {
      entry = await this.ensureChat(message.channelId, message.chatId)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.deps.log.error(`chat ${key} 无 agent 承接：${detail}`)
      await this.replyText(message, `Error: ${detail}`)
      return
    }

    if (Date.now() < entry.ignoreUntil) {
      this.deps.log.info(
        `chat ${key} 处于本人回复后的免打扰窗口（剩余 ${Math.ceil((entry.ignoreUntil - Date.now()) / 1000)}s），消息不处理`,
      )
      return
    }

    const plain = partsToPlainText(message.parts)
    const parsed = parseCommandText(plain)
    if (parsed !== null) {
      const ctx: CommandContext = {
        channelId: message.channelId,
        chatId: message.chatId,
        reply: async (text) => {
          await this.replyText(message, text)
        },
      }
      const handled = await entry.registry.execute(ctx, parsed.name, parsed.args)
      if (handled) return
    }

    try {
      await this.runAssistantTurn(entry, message)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.deps.log.error(`chat ${key} agent 处理异常：${detail}`)
      await this.replyText(message, `Error: ${detail}`)
    }
  }

  private async runAssistantTurn(entry: ChatEntry, message: ChatMessage): Promise<void> {
    const promptText = partsToPromptText(message.parts)
    if (promptText === '') {
      this.deps.log.info(`chat ${entry.key} 消息无可用内容（文本/附件均为空），跳过 agent`)
      return
    }

    const content = renderPrompt({
      channelId: message.channelId,
      chatId: message.chatId,
      messageId: message.id,
      replyTo: message.replyTo,
      content: promptText,
    })

    const channel = this.deps.getChannel(message.channelId)
    const stopTyping = channel?.beginTyping(message.chatId) ?? (() => {})

    try {
      for await (const turn of entry.runtime.prompt(content)) {
        if (turn.status === 'cancelled') {
          this.deps.log.info(`chat ${entry.key} agent turn 被取消，本条消息不再回复`)
          continue
        }
        if (turn.status !== 'completed' && turn.status !== 'failed') continue

        const parts = [...turn.parts]
        if (turn.status === 'failed') {
          const detail = turn.error ?? 'agent turn failed'
          this.deps.log.error(`chat ${entry.key} agent turn 失败：${detail}`)
          parts.push({ kind: 'text', text: `Error: ${detail}` })
        }
        if (parts.length === 0) {
          this.deps.log.info(`chat ${entry.key} agent turn 完成但无直接输出（agent 可能已自行调用 send_message 回复）`)
          continue
        }

        const assistant = this.currentAssistant(entry.assistantId)
        const forwardTo = assistant?.forward_to
        await this.sendMessage({
          channelId: message.channelId,
          chatId: message.chatId,
          parts,
          receiver: forwardTo !== undefined && forwardTo !== '' ? forwardTo : null,
        })
      }
    } finally {
      stopTyping()
    }
  }

  private async ensureChat(channelId: string, chatId: string): Promise<ChatEntry> {
    const key = chatKey(channelId, chatId)
    const existing = this.chats.get(key)
    if (existing !== undefined) return existing

    const binding = resolveBinding(this.deps.store.current.bindings, channelId, chatId)
    const assistant = this.currentAssistant(binding.assistant_id)
    if (assistant === undefined) throw new Error(`assistant 不存在：${binding.assistant_id}`)

    this.deps.log.info(`chat ${channelId}/${chatId} 绑定 assistant "${assistant.id}" (agent: ${assistant.agent_id})`)

    const runtime = await this.deps.createRuntime(assistant)
    const instruction = renderSystemInstruction(assistant.instruction, {
      mcpName: this.deps.mcpName,
      channelContext: { message_syntax: null },
    })
    await runtime.newSession(instruction)

    const registry = new CommandRegistry(this.globalRegistry)
    registry.register({
      name: 'new',
      description: '开启新会话',
      handler: async () => {
        await runtime.newSession(instruction)
        return 'ok'
      },
    })
    registry.register({
      name: 'model',
      description: '查看或切换模型（/model 或 /model <value>）',
      handler: async (_ctx, args) => {
        const value = args[0]
        if (value === undefined) {
          const [current, options] = await Promise.all([runtime.currentModel(), runtime.listModels()])
          const lines = options.map((option) => `${option.value}: ${option.name}`)
          const list = lines.length > 0 ? lines.join('\n') : '（配置里没有 models 候选）'
          return `current: ${current ?? '(agent 默认)'}\n\n${list}`
        }
        const ok = await runtime.setModel(value)
        return ok ? 'ok（新会话已生效）' : 'failed：不在候选列表内'
      },
    })

    const entry: ChatEntry = {
      key,
      channelId,
      chatId,
      assistantId: assistant.id,
      runtime,
      registry,
      ignoreUntil: 0,
      unsubs: [],
    }
    // assistant 配置变更/删除 → 会话失效，下条消息按新配置重建
    entry.unsubs.push(
      this.deps.store.subscribePath(`assistants.${assistant.id}`, () => {
        this.deps.log.info(`assistant "${assistant.id}" 配置变更：chat ${key} 会话失效，下条消息重建`)
        this.disposeChat(key)
      }),
    )

    this.chats.set(key, entry)
    return entry
  }

  private currentAssistant(id: string): AssistantConfig | undefined {
    return this.deps.store.current.assistants.find((assistant) => assistant.id === id)
  }

  private async replyText(source: ChatMessage, text: string): Promise<void> {
    try {
      await this.sendMessage({
        channelId: source.channelId,
        chatId: source.chatId,
        parts: [{ kind: 'text', text }],
      })
    } catch (error) {
      this.deps.log.error(
        `chat ${chatKey(source.channelId, source.chatId)} 回复失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private disposeChat(key: string): void {
    const entry = this.chats.get(key)
    if (entry === undefined) return
    this.chats.delete(key)
    for (const unsub of entry.unsubs) unsub()
    void entry.runtime.dispose()
  }

  dispose(): void {
    this.disposeAll()
    for (const unsub of this.unsubs) unsub()
  }
}

function chatKey(channelId: string, chatId: string): string {
  return `${channelId} ${chatId}`
}
