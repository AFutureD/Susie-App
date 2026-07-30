import { isTriggerSatisfied, resolveBinding } from '../../shared/bindings'
import { decodeChatId } from '../../shared/chat-id'
import type { AssistantConfig, ChatBinding } from '../../shared/config'
import { errorMessage } from '../../shared/errors'
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
import { PermissionGate, type GateDecision } from './permission-gate'

/** 自己在别的客户端亲自回复后，忽略该会话新消息的时长（对位 Python IGNORE_MESSAGE_DURATION） */
const IGNORE_AFTER_SELF_REPLY_MS = 120_000

/** 入站消息在管线各阶段间传递的上下文（一次入站一份，阶段按序填充） */
interface InboundContext {
  readonly envelope: InboundEnvelope
  readonly message: ChatMessage
  readonly key: string
  /** owner 批准重放：跳过身份门与免打扰窗（路由仍要重查——绑定可能已失效） */
  readonly preapproved: boolean
  readonly chatType: string | null
  binding: ChatBinding | null
  command: { name: string; args: string[] } | null
  gate: GateDecision | null
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

/**
 * 当前 turn 的默认回复锚点（Telegram 普通线程 fallback）。generation 令牌用于
 * 区分并发 process/consume：只有创建它的 turn 才能清除自己的条目，防止后到的
 * turn 覆盖后被前一个 consume 的 finally 误删。
 */
interface TurnAnchor {
  gen: number
  messageId: string | null
}

export class ChatManager {
  private readonly deps: ChatManagerDeps
  private readonly chats = new Map<string, ChatEntry>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly globalRegistry = new CommandRegistry()
  private readonly unsubs: Unsubscribe[] = []
  private readonly gate: PermissionGate
  private readonly activeTurnAnchors = new Map<string, TurnAnchor>()
  private turnAnchorGen = 0

  constructor(deps: ChatManagerDeps) {
    this.deps = deps
    this.gate = new PermissionGate({
      store: deps.store,
      isCommandGated: (name) => this.isCommandGated(name),
      requestApproval: deps.requestApproval,
      autoReview: deps.autoReview,
      beginAutoReview: deps.beginAutoReview,
      settleAutoReview: deps.settleAutoReview,
      reply: (source, text) => this.replyText(source, text),
      log: deps.log,
    })
    // 检视命令（对位 Python Inspector）：只依赖 ctx，注册在全局链
    this.globalRegistry.register({
      name: 'chat_id',
      description: '显示当前 chat id',
      gated: false,
      handler: (ctx) => ctx.chatId,
    })
    // binding 变化 → 按会话比对路由结论，结论变了才失效（改一条无关绑定不再殃及全部活跃会话）。
    // 只比较 assistant_id：only_mention 在触发判定时现读、send_output 在发送时现读（变更即时生效），
    // 会话 runtime 的构造输入里来自 binding 的只有 assistant_id。
    this.unsubs.push(
      deps.store.subscribePath('bindings', (next, prev) => {
        const prevBindings = (prev ?? []) as ChatBinding[]
        const nextBindings = (next ?? []) as ChatBinding[]
        for (const entry of Array.from(this.chats.values())) {
          const before = resolveBinding(prevBindings, entry.channelId, entry.chatId)?.assistant_id ?? null
          const after = resolveBinding(nextBindings, entry.channelId, entry.chatId)?.assistant_id ?? null
          if (before !== after) {
            this.deps.log.info(`bindings 变更：chat ${entry.key} 路由结论变化，会话失效（下条消息重建）`)
            void this.disposeChat(entry.key)
          }
        }
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

    // broadcast channel（C:*）：只做历史归档，不做绑定/命令/权限/回复。
    // 定位：channel 是"消息来源"而非"对话对象"——bot 不参与 channel 的会话循环。
    if (decodeChatId(message.chatId)?.chatType === 'channel') return

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

  /**
   * UI composer / MCP send_message 出站入口。
   * replyTo 语义：
   * - undefined + useTurnAnchor=true → 用当前 turn 的锚点（若无则 null）
   * - null → 显式跳出锚点（普通线程 fallback 用作 opt-out）
   * - 字符串 → 显式覆盖
   * UI / 定时任务不设 useTurnAnchor，行为不变。
   */
  async sendMessage(input: {
    channelId: string
    chatId: string
    parts: MessagePart[]
    receiver?: string | null
    replyTo?: string | null
    useTurnAnchor?: boolean
  }): Promise<StoredMessage> {
    const channel = this.deps.getChannel(input.channelId)
    if (channel === undefined) throw new Error(`通道未运行：${input.channelId}`)

    const replyTo = this.resolveReplyTo(input.channelId, input.chatId, input.replyTo, input.useTurnAnchor === true)

    const message: ChatMessage = {
      id: null,
      channelId: input.channelId,
      chatId: input.chatId,
      receiver: input.receiver ?? null,
      replyTo,
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

  /** 当前 turn 的默认回复锚点（普通线程 fallback）；MCP bridge 用它把 undefined 归零到具体值 */
  currentTurnAnchor(channelId: string, chatId: string): string | null {
    return this.activeTurnAnchors.get(chatKey(channelId, chatId))?.messageId ?? null
  }

  private resolveReplyTo(
    channelId: string,
    chatId: string,
    explicit: string | null | undefined,
    useTurnAnchor: boolean,
  ): string | null {
    if (explicit !== undefined) return explicit
    if (!useTurnAnchor) return null
    return this.currentTurnAnchor(channelId, chatId)
  }

  onChannelRemoved(channelId: string): void {
    for (const entry of Array.from(this.chats.values())) {
      if (entry.channelId === channelId) void this.disposeChat(entry.key)
    }
  }

  /** 全部会话销毁；stop 路径 await（限时收尸子进程），热更新路径 fire-and-forget */
  disposeAll(): Promise<void> {
    const keys = Array.from(this.chats.keys())
    return Promise.allSettled(keys.map((key) => this.disposeChat(key))).then(() => undefined)
  }

  // ---------- 内部 ----------

  private enqueue(key: string, fn: () => Promise<void>): void {
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(fn).catch((error: unknown) => {
      this.deps.log.error(`chat ${key} 处理失败：${error instanceof Error ? error.message : String(error)}`)
    })
    this.queues.set(key, next)
  }

  /**
   * 入站处理管线（每会话串行队列内执行）：
   * ① 路由 → ② 命令解析 → ③ 身份门 → ④ 会话确保 → ⑤ 免打扰窗 → ⑥ 命令分发 → ⑦ agent turn。
   * 不是通用 middleware 框架——命名阶段方法 + 线性 driver 就是终态。
   * process 生命周期覆盖回复锚点：全部早退分支都会清；进入 turn 时把清理权移交给 consume。
   */
  private async process(envelope: InboundEnvelope, opts: { preapproved?: boolean } = {}): Promise<void> {
    const ctx = this.createContext(envelope, opts)
    const anchorGen = this.setTurnAnchor(ctx.key, envelope.threadAnchorMessageId ?? null)
    let handedOffToTurn = false
    try {
      if (!this.resolveRoute(ctx)) return
      this.parseCommand(ctx)
      ctx.gate = ctx.preapproved ? { kind: 'pass' } : await this.gate.evaluate(ctx)
      if (ctx.gate.kind === 'handled') return
      const entry = await this.ensureChatOrReply(ctx)
      if (entry === null) return
      if (this.inDoNotDisturbWindow(ctx, entry)) return
      if (await this.dispatchCommand(ctx, entry)) return
      handedOffToTurn = true
      this.runAssistantTurn(entry, ctx.message, anchorGen)
    } finally {
      if (!handedOffToTurn) this.clearTurnAnchor(ctx.key, anchorGen)
    }
  }

  private setTurnAnchor(key: string, messageId: string | null): number {
    const gen = ++this.turnAnchorGen
    this.activeTurnAnchors.set(key, { gen, messageId })
    return gen
  }

  private clearTurnAnchor(key: string, gen: number): void {
    const current = this.activeTurnAnchors.get(key)
    if (current !== undefined && current.gen === gen) this.activeTurnAnchors.delete(key)
  }

  private createContext(envelope: InboundEnvelope, opts: { preapproved?: boolean }): InboundContext {
    const { message } = envelope
    return {
      envelope,
      message,
      key: chatKey(message.channelId, message.chatId),
      preapproved: opts.preapproved === true,
      chatType: decodeChatId(message.chatId)?.chatType ?? null,
      binding: null,
      command: null,
      gate: null,
    }
  }

  /** ① 路由：绑定命中 + 触发条件（群内 @ 提及）。未命中静默——不是权限拒绝，是无路由。 */
  private resolveRoute(ctx: InboundContext): boolean {
    const binding = resolveBinding(this.deps.store.current.bindings, ctx.message.channelId, ctx.message.chatId)
    if (binding === null) {
      this.deps.log.info(
        `chat ${ctx.key} 无绑定且通道无默认助手，不响应${ctx.preapproved ? '（审核通过但绑定已失效）' : ''}`,
      )
      return false
    }
    if (!isTriggerSatisfied(binding, { chatType: ctx.chatType, mentioned: ctx.envelope.mentioned })) {
      this.deps.log.info(`chat ${ctx.key} 群消息未 @ 提及，不触发`)
      return false
    }
    ctx.binding = binding
    return true
  }

  /** ② 命令先于身份门解析：命令有权限分类（免审命令无权限也响应） */
  private parseCommand(ctx: InboundContext): void {
    ctx.command = parseCommandText(partsToPlainText(ctx.message.parts))
  }

  /** ④ 会话确保（身份门之后——被拦/暂存的消息不建 runtime）；失败给会话内 Error 反馈 */
  private async ensureChatOrReply(ctx: InboundContext): Promise<ChatEntry | null> {
    const binding = ctx.binding
    if (binding === null) return null
    try {
      return await this.ensureChat(ctx.message.channelId, ctx.message.chatId, binding.assistant_id)
    } catch (error) {
      const detail = errorMessage(error)
      this.deps.log.error(`chat ${ctx.key} 无 agent 承接：${detail}`)
      await this.replyText(ctx.message, `Error: ${detail}`)
      return null
    }
  }

  /** ⑤ 免打扰窗：本人亲自回复后 120s 静默；owner 的显式批准穿透 */
  private inDoNotDisturbWindow(ctx: InboundContext, entry: ChatEntry): boolean {
    if (ctx.preapproved || Date.now() >= entry.ignoreUntil) return false
    this.deps.log.info(
      `chat ${ctx.key} 处于本人回复后的免打扰窗口（剩余 ${Math.ceil((entry.ignoreUntil - Date.now()) / 1000)}s），消息不处理`,
    )
    return true
  }

  /** ⑥ 命令分发：registry 命中即终结；未注册命令 fall through 给 assistant（按普通消息管控） */
  private async dispatchCommand(ctx: InboundContext, entry: ChatEntry): Promise<boolean> {
    if (ctx.command === null) return false
    const commandCtx: CommandContext = {
      channelId: ctx.message.channelId,
      chatId: ctx.message.chatId,
      // 免审放行的命令降权（help 据此隐藏需审核命令）；直通/批准重放为完整权限
      gatedAllowed: ctx.gate?.kind !== 'exempt',
      reply: async (text) => {
        await this.replyText(ctx.message, text)
      },
    }
    return entry.registry.execute(commandCtx, ctx.command.name, ctx.command.args)
  }

  private runAssistantTurn(entry: ChatEntry, message: ChatMessage, anchorGen: number): void {
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
            useTurnAnchor: true,
          })
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        this.deps.log.error(`chat ${entry.key} agent 处理异常：${detail}`)
        await this.replyText(message, `Error: ${detail}`)
      } finally {
        stopTyping()
        this.clearTurnAnchor(entry.key, anchorGen)
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
        void this.disposeChat(key)
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
        useTurnAnchor: true,
      })
    } catch (error) {
      this.deps.log.error(
        `chat ${chatKey(source.channelId, source.chatId)} 回复失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private disposeChat(key: string): Promise<void> {
    const entry = this.chats.get(key)
    if (entry === undefined) return Promise.resolve()
    this.chats.delete(key)
    for (const unsub of entry.unsubs) unsub()
    return entry.runtime.dispose()
  }

  async dispose(): Promise<void> {
    const disposed = this.disposeAll()
    for (const unsub of this.unsubs) unsub()
    await disposed
  }
}

function chatKey(channelId: string, chatId: string): string {
  return `${channelId} ${chatId}`
}
