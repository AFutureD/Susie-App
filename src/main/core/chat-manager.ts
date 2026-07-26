import { isTriggerSatisfied, resolveBinding } from '../../shared/bindings'
import { decodeChatId } from '../../shared/chat-id'
import { channelOwner, permissionFor } from '../../shared/users'
import type { AssistantConfig } from '../../shared/config'
import {
  partsToPlainText,
  partsToPromptText,
  type ChatMessage,
  type InboundEnvelope,
  type MessagePart,
  type StoredMessage,
} from '../../shared/messages'
import type { AgentRuntime } from '../agents/types'
import type { Channel } from '../channels/types'
import type { ConfigStore, Unsubscribe } from '../config/store'
import type { MessageRepo } from '../history/message-repo'
import type { PendingApproval } from './approval-repo'
import { ASSISTANT_COMMAND_SPECS, assistantCommands } from '../replier/commands'
import { renderPrompt, renderSystemInstruction } from '../replier/templates'
import type { Logger } from '../util/logger'
import type { AutoReviewVerdict } from './auto-review'
import { CommandRegistry, parseCommandText, type CommandContext, type CommandSpec } from './commands'

/** 自己在别的客户端亲自回复后，忽略该会话新消息的时长（对位 Python IGNORE_MESSAGE_DURATION） */
const IGNORE_AFTER_SELF_REPLY_MS = 120_000

// 权限拦截的会话反馈（不静默：被拦下的发送者要知道原因；纯路由缺失不回复）
const PERMISSION_IGNORED_NOTICE = '⛔ 你没有使用权限。'
const NO_OWNER_NOTICE = '⚠️ 该频道未绑定 owner，消息无法审核。'

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
  messages: MessageRepo
  mcpName: string
  getChannel: (id: string) => Channel | undefined
  createRuntime: (assistant: AssistantConfig) => Promise<AgentRuntime>
  onHistoryMessage: (message: StoredMessage) => void
  /**
   * member/未登记发送者的消息转 owner 审核（暂存 + 发卡片；不等待审核结果）。
   * autoReviewReason 非空表示由自动审核未通过回落而来，会附到审核卡片。
   */
  requestApproval: (envelope: InboundEnvelope, options?: { autoReviewReason?: string | null }) => Promise<void>
  /** 自动审核档（auto）：评估消息是否放行；未通过则回落人工审核 */
  autoReview: (envelope: InboundEnvelope) => Promise<AutoReviewVerdict>
  /** auto 档：审核前发「自动审核中」进度卡片；无 owner/发送失败返回 null（审核照常） */
  beginAutoReview: (envelope: InboundEnvelope) => Promise<PendingApproval | null>
  /** auto 档：结论落卡片（通过→终止按钮；拒绝→转人工 + 允许/拒绝按钮 + member 通知） */
  settleAutoReview: (pending: PendingApproval, verdict: AutoReviewVerdict) => Promise<void>
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
    // 检视命令（对位 Python Inspector）：只依赖 ctx，注册在全局链
    this.globalRegistry.register({
      name: 'chat_id',
      description: '显示当前 chat id',
      gated: false,
      handler: (ctx) => ctx.chatId,
    })
    // binding 变化 → 全部会话下次消息时按新 binding 重建
    this.unsubs.push(
      deps.store.subscribePath('bindings', () => {
        this.deps.log.info('bindings 变更：所有会话失效，下条消息按新绑定重建')
        this.disposeAll()
      }),
    )
  }

  /** 命令全集（全局 + per-chat assistant 命令；同名以 per-chat 为准），供通道注册命令菜单与权限分类 */
  listCommandSpecs(): CommandSpec[] {
    const merged = new Map<string, CommandSpec>()
    for (const { name, description, gated } of this.globalRegistry.list()) {
      merged.set(name, { name, description, gated })
    }
    for (const spec of ASSISTANT_COMMAND_SPECS) merged.set(spec.name, spec)
    return [...merged.values()]
  }

  /** 命令权限分类；未注册的命令会转交 assistant，按普通消息管控（需要审核） */
  private isCommandGated(name: string): boolean {
    const spec = this.listCommandSpecs().find((item) => item.name === name)
    return spec?.gated ?? true
  }

  /** 通道入站回调 */
  handleInbound(envelope: InboundEnvelope): void {
    const { message, chatName } = envelope
    const stored = this.deps.messages.record(message, chatName)
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

    this.enqueue(key, () => this.process(envelope))
  }

  /** owner 批准后的重放入口：不再落库（到达时已记录），跳过角色门与免打扰窗 */
  handleApproved(pending: PendingApproval): void {
    const key = chatKey(pending.channelId, pending.chatId)
    this.enqueue(key, () => this.process(pending.envelope, { preapproved: true }))
  }

  /**
   * owner 急停（审核卡片「终止」按钮）：取消该会话当前活跃的 agent turn。
   * 返回是否命中活跃会话（会话不存在/已结束返回 false，卡片据此提示）。
   */
  async cancelActiveTurn(channelId: string, chatId: string): Promise<boolean> {
    const entry = this.chats.get(chatKey(channelId, chatId))
    if (entry === undefined) return false
    this.deps.log.info(`chat ${entry.key} owner 急停：取消进行中的 turn`)
    await entry.runtime.cancel()
    return true
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
      senderId: null,
      timestamp: Date.now(),
      parts: input.parts,
    }
    const sent = await channel.sendMessage(message)
    const stored = this.deps.messages.record(sent)
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

  private async process(envelope: InboundEnvelope, opts: { preapproved?: boolean } = {}): Promise<void> {
    const { message, mentioned } = envelope
    const preapproved = opts.preapproved === true
    const key = chatKey(message.channelId, message.chatId)

    // 路由：绑定未命中 = 无助手承接（不回复——不是权限拒绝，是无路由）
    const binding = resolveBinding(this.deps.store.current.bindings, message.channelId, message.chatId)
    if (binding === null) {
      this.deps.log.info(`chat ${key} 无绑定且通道无默认助手，不响应${preapproved ? '（审核通过但绑定已失效）' : ''}`)
      return
    }
    // 会话触发条件（群内 @ 提及要求）——未触发不算被拦，不回复
    const chatType = decodeChatId(message.chatId)?.chatType ?? null
    if (!isTriggerSatisfied(binding, { chatType, mentioned })) {
      this.deps.log.info(`chat ${key} 群消息未 @ 提及，不触发`)
      return
    }

    // 命令先于身份门解析：命令有权限分类（免审命令无权限也响应）
    const plain = partsToPlainText(message.parts)
    const parsed = parseCommandText(plain)

    // 身份门（在 ensureChat 之前——被拦/暂存的消息不建 runtime）：
    // owner 全局直通；其余按发送者在该范围（私聊/具体群）的档位。被拦下的发送者给出明确反馈，不静默。
    let gatedAllowed = true // 直通档 / owner / 批准重放；免审执行时降为 false（help 据此隐藏需审核命令）
    if (!preapproved) {
      const users = this.deps.store.current.users
      const permission = permissionFor(users, message.channelId, message.senderId, message.chatId, chatType)
      if (permission === 'ignore') {
        this.deps.log.info(`chat ${key} 发送者 ${message.senderId ?? '?'} 在该范围为忽略档，不响应`)
        await this.replyText(message, PERMISSION_IGNORED_NOTICE)
        return
      }
      if (permission === 'review' || permission === 'auto') {
        // 免审命令（help / chat_id / new）：审核/自动档用户也直接执行；忽略档不豁免（显式拉黑强于免审）
        const exemptCommand = parsed !== null && !this.isCommandGated(parsed.name)
        if (exemptCommand) {
          this.deps.log.info(`chat ${key} 免审命令 /${parsed.name}：${permission} 档发送者直接执行`)
          gatedAllowed = false
        } else {
          // 自动档：先发「审核中」进度卡片（尽力而为），再跑自动审核。
          // 通过 → 卡片更新为可终止（急停），放行处理；未通过 → 卡片转人工（附拒绝原因）。
          let autoPassed = false
          let autoReviewReason: string | null = null
          if (permission === 'auto') {
            const card = await this.deps.beginAutoReview(envelope)
            const verdict = await this.deps.autoReview(envelope)
            if (verdict.passed) {
              autoPassed = true
              this.deps.log.info(`chat ${key} 发送者 ${message.senderId ?? '?'} 自动审核通过，放行`)
              if (card !== null) await this.deps.settleAutoReview(card, verdict)
            } else {
              autoReviewReason = verdict.reason
              this.deps.log.info(
                `chat ${key} 发送者 ${message.senderId ?? '?'} 自动审核未通过（${verdict.reason ?? '无理由'}），回落人工审核`,
              )
              if (card !== null) {
                // 卡片就位：settle 负责转人工（原因 + 允许/拒绝按钮 + member 通知），不再另发卡片
                await this.deps.settleAutoReview(card, verdict)
                return
              }
            }
          }
          if (!autoPassed) {
            if (channelOwner(users, message.channelId) === null) {
              this.deps.log.info(`chat ${key} 需审核但频道未绑定 owner，无人可审，不响应`)
              await this.replyText(message, NO_OWNER_NOTICE)
              return
            }
            this.deps.log.info(`chat ${key} 发送者 ${message.senderId ?? '?'} 转 owner 审核`)
            await this.deps.requestApproval(envelope, { autoReviewReason })
            return
          }
          // autoPassed：落到下方按直通处理（gatedAllowed 维持 true）
        }
      }
    }

    let entry: ChatEntry
    try {
      entry = await this.ensureChat(message.channelId, message.chatId, binding.assistant_id)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.deps.log.error(`chat ${key} 无 agent 承接：${detail}`)
      await this.replyText(message, `Error: ${detail}`)
      return
    }

    // owner 的显式批准优先于本人回复后的静默窗
    if (!preapproved && Date.now() < entry.ignoreUntil) {
      this.deps.log.info(
        `chat ${key} 处于本人回复后的免打扰窗口（剩余 ${Math.ceil((entry.ignoreUntil - Date.now()) / 1000)}s），消息不处理`,
      )
      return
    }

    if (parsed !== null) {
      const ctx: CommandContext = {
        channelId: message.channelId,
        chatId: message.chatId,
        gatedAllowed,
        reply: async (text) => {
          await this.replyText(message, text)
        },
      }
      const handled = await entry.registry.execute(ctx, parsed.name, parsed.args)
      if (handled) return
    }

    this.runAssistantTurn(entry, message)
  }

  private runAssistantTurn(entry: ChatEntry, message: ChatMessage): void {
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

    // turn 消费在队列临界区外进行：活跃 turn 期间到达的新消息能立即进入 runtime.prompt，
    // codex 会把它 steer 进当前 turn（返回空流），ACP 则在 runtime 内部串行排队
    const consume = async () => {
      try {
        for await (const turn of entry.runtime.prompt(content)) {
          if (turn.status === 'cancelled') {
            this.deps.log.info(`chat ${entry.key} agent turn 被取消，本条消息不再回复`)
            continue
          }
          if (turn.status !== 'completed' && turn.status !== 'failed') continue

          // agent 运行期间的直接产出（过程 quote 与结果文本）默认不发送——回复走 MCP send_message；
          // 绑定开启 send_output 后才整体发到会话（发送时现取配置，开关即时生效）。
          // 失败时的 Error 提示是本层的反馈，不受开关影响。
          const binding = resolveBinding(this.deps.store.current.bindings, message.channelId, message.chatId)
          const sendOutput = binding?.send_output === true
          const parts = sendOutput ? [...turn.parts] : []
          if (!sendOutput && turn.parts.length > 0) {
            this.deps.log.info(`chat ${entry.key} 已按绑定配置省略 ${turn.parts.length} 段 agent 直接输出`)
          }
          if (turn.status === 'failed') {
            const detail = turn.error ?? 'agent turn failed'
            this.deps.log.error(`chat ${entry.key} agent turn 失败：${detail}`)
            parts.push({ kind: 'text', text: `Error: ${detail}` })
          }
          if (parts.length === 0) {
            this.deps.log.info(
              `chat ${entry.key} agent turn 完成但无直接输出（agent 可能已自行调用 send_message 回复）`,
            )
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
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.deps.log.error(`chat ${entry.key} agent 处理异常：${detail}`)
        await this.replyText(message, `Error: ${detail}`)
      } finally {
        stopTyping()
      }
    }
    void consume()
  }

  private async ensureChat(channelId: string, chatId: string, assistantId: string): Promise<ChatEntry> {
    const key = chatKey(channelId, chatId)
    const existing = this.chats.get(key)
    if (existing !== undefined) return existing

    const assistant = this.currentAssistant(assistantId)
    if (assistant === undefined) throw new Error(`assistant 不存在：${assistantId}`)

    this.deps.log.info(`chat ${channelId}/${chatId} 绑定 assistant "${assistant.id}" (agent: ${assistant.agent_id})`)

    const runtime = await this.deps.createRuntime(assistant)
    const instruction = renderSystemInstruction(assistant.instruction, {
      mcpName: this.deps.mcpName,
      channelContext: { message_syntax: null },
    })
    await runtime.newSession(instruction)

    const registry = new CommandRegistry(this.globalRegistry)
    registry.registerAll(assistantCommands(runtime, instruction))

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
