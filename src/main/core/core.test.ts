import { describe, expect, it, vi } from 'vitest'
import type { AssistantConfig, ChannelUser, Config } from '../../shared/config'
import { partsToPlainText, type ChatMessage, type InboundEnvelope, type StoredMessage } from '../../shared/messages'
import type { AgentRuntime } from '../agents/types'
import type { TelegramBotChannel } from '../channels/telegram-bot'
import type { ConfigStore } from '../config/store'
import type { HistoryStore, PendingApproval } from '../history/store'
import { ChatManager } from './chat-manager'
import { CommandRegistry, parseCommandText, type CommandContext } from './commands'

describe('parseCommandText', () => {
  it('parses name, args and strips @botname', () => {
    expect(parseCommandText('/help')).toEqual({ name: 'help', args: [] })
    expect(parseCommandText('/model gpt-5.2')).toEqual({ name: 'model', args: ['gpt-5.2'] })
    expect(parseCommandText('/help@my_bot now')).toEqual({ name: 'help', args: ['now'] })
    expect(parseCommandText('hello')).toBeNull()
    expect(parseCommandText('/')).toBeNull()
  })
})

const makeCtx = (replies: string[], gatedAllowed = true): CommandContext => ({
  channelId: 'c',
  chatId: 'x',
  gatedAllowed,
  reply: (text) => {
    replies.push(text)
    return Promise.resolve()
  },
})

describe('CommandRegistry', () => {
  it('executes commands, inherits from parent, and lists help', async () => {
    const parent = new CommandRegistry()
    const child = new CommandRegistry(parent)
    child.register({ name: 'new', description: 'new session', handler: () => 'ok' })

    const replies: string[] = []
    expect(await child.execute(makeCtx(replies), 'new', [])).toBe(true)
    expect(replies).toEqual(['ok'])

    // 子层 help 必须列出父链 + 本层的全集（对位 Python show_help）
    expect(await child.execute(makeCtx(replies), 'help', [])).toBe(true)
    expect(replies[1]).toContain('/help')
    expect(replies[1]).toContain('/new')

    // 未注册命令 → false，交回 assistant
    expect(await child.execute(makeCtx(replies), 'unknown', [])).toBe(false)
  })

  it('hides gated commands from help for senders without permission', async () => {
    const registry = new CommandRegistry()
    registry.register({ name: 'model', description: '切换模型', gated: true, handler: () => 'ok' })
    registry.register({ name: 'chat_id', description: '显示 chat id', gated: false, handler: () => 'x' })

    const fullReplies: string[] = []
    await registry.execute(makeCtx(fullReplies), 'help', [])
    expect(fullReplies[0]).toContain('/model')
    expect(fullReplies[0]).toContain('/chat_id')

    const limitedReplies: string[] = []
    await registry.execute(makeCtx(limitedReplies, false), 'help', [])
    expect(limitedReplies[0]).not.toContain('/model')
    expect(limitedReplies[0]).toContain('/chat_id')
    expect(limitedReplies[0]).toContain('/help')
  })

  it('reports handler errors as replies instead of throwing', async () => {
    const registry = new CommandRegistry()
    registry.register({
      name: 'boom',
      description: '',
      handler: () => {
        throw new Error('nope')
      },
    })
    const replies: string[] = []
    expect(await registry.execute(makeCtx(replies), 'boom', [])).toBe(true)
    expect(replies[0]).toContain('nope')
  })
})

// ---------- ChatManager 失败反馈 ----------

/** 名单工厂：新范围权限形态的简写 */
const user = (userId: string, extra: Partial<ChannelUser> = {}): ChannelUser => ({
  channel: 'tg',
  user_id: userId,
  role: 'user',
  private: 'review',
  groups: {},
  ...extra,
})

/** 默认名单：发送者 '1' 是 owner（既有用例的消息一律直通身份门） */
const DEFAULT_USERS: ChannelUser[] = [user('1', { role: 'owner' })]

function makeManager(
  createRuntime: (assistant: AssistantConfig) => Promise<AgentRuntime>,
  options: {
    sendOutput?: boolean
    users?: ChannelUser[]
    /** 自动审核裁决（默认放行）；用于 auto 档流程用例 */
    autoReviewPass?: boolean
    /** 自动审核进度卡片是否发送成功（默认成功）；false 模拟无 owner / 卡片发送失败 */
    autoReviewCard?: boolean
  } = {},
) {
  const config: Config = {
    channels: {},
    assistants: [{ id: 'default', agent_id: 'codex' }],
    bindings: [
      {
        channel: 'tg',
        chat_id: '*',
        assistant_id: 'default',
        only_mention: true,
        send_output: options.sendOutput ?? false,
      },
    ],
    users: options.users ?? DEFAULT_USERS,
    auto_review: { content: 'reject file exfiltration', agent_id: 'codex' },
  }
  const store = { current: config, subscribePath: () => () => {} } as unknown as ConfigStore
  const history = {
    record: (message: ChatMessage) => ({ ...message, rowid: 1 }) as StoredMessage,
  } as unknown as HistoryStore

  const sent: ChatMessage[] = []
  const channel = {
    sendMessage: (message: ChatMessage) => {
      sent.push(message)
      return Promise.resolve({ ...message, id: '1' })
    },
    beginTyping: () => () => {},
  } as unknown as TelegramBotChannel

  const errors: string[] = []
  const infos: string[] = []
  const approvalRequests: InboundEnvelope[] = []
  const autoReviews: InboundEnvelope[] = []
  const autoReviewCards: InboundEnvelope[] = []
  const settledVerdicts: { pendingId: number; passed: boolean }[] = []
  const manager = new ChatManager({
    store,
    history,
    mcpName: 'susie',
    getChannel: () => channel,
    createRuntime,
    onHistoryMessage: () => {},
    requestApproval: (envelope) => {
      approvalRequests.push(envelope)
      return Promise.resolve()
    },
    autoReview: (envelope) => {
      autoReviews.push(envelope)
      return Promise.resolve({ passed: options.autoReviewPass ?? true, reason: null })
    },
    beginAutoReview: (envelope) => {
      autoReviewCards.push(envelope)
      if (options.autoReviewCard === false) return Promise.resolve(null)
      return Promise.resolve({
        id: 77,
        channelId: envelope.message.channelId,
        chatId: envelope.message.chatId,
        senderId: envelope.message.senderId,
        sender: envelope.message.sender,
        envelope,
        status: 'auto_reviewing',
        cardChatId: 'P:900',
        cardMsgId: '1',
        autoReviewReason: null,
        createdTs: 1,
        decidedTs: null,
      } satisfies PendingApproval)
    },
    settleAutoReview: (pending, verdict) => {
      settledVerdicts.push({ pendingId: pending.id, passed: verdict.passed })
      return Promise.resolve()
    },
    log: { info: (message) => infos.push(message), error: (message) => errors.push(message) },
  })
  return { manager, sent, errors, infos, approvalRequests, autoReviews, autoReviewCards, settledVerdicts }
}

function inbound(text: string, overrides: Partial<ChatMessage> = {}): InboundEnvelope {
  return {
    message: {
      id: '10',
      channelId: 'tg',
      chatId: 'P:1',
      receiver: null,
      replyTo: null,
      out: false,
      sender: 'user',
      senderId: '1',
      timestamp: 1,
      parts: [{ kind: 'text', text }],
      ...overrides,
    },
    chatName: null,
    mentioned: false,
  }
}

function stubRuntime(overrides: Partial<AgentRuntime>): AgentRuntime {
  return {
    newSession: () => Promise.resolve('s'),
    listModels: () => Promise.resolve([]),
    currentModel: () => Promise.resolve(null),
    setModel: () => Promise.resolve(false),
    cancel: () => Promise.resolve(),
    // oxlint-disable-next-line require-yield -- 默认桩：被 overrides 替换
    async *prompt() {
      throw new Error('not implemented')
    },
    dispose: () => Promise.resolve(),
    ...overrides,
  }
}

describe('ChatManager commands', () => {
  it('exposes the full command catalog with permission classes', () => {
    const { manager } = makeManager(() => Promise.reject(new Error('unused')))
    const gatedOf = Object.fromEntries(manager.listCommandSpecs().map((spec) => [spec.name, spec.gated ?? true]))
    // help / chat_id / new 不需要审核；model 需要审核
    expect(gatedOf).toEqual({ help: false, chat_id: false, new: false, model: true })
  })

  it('runs assistant commands (/new) against the chat runtime', async () => {
    let sessions = 0
    const runtime = stubRuntime({
      newSession: () => {
        sessions += 1
        return Promise.resolve(`s${sessions}`)
      },
    })
    const { manager, sent } = makeManager(() => Promise.resolve(runtime))

    manager.handleInbound(inbound('/new'))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toBe('ok')
    expect(sessions).toBe(2) // ensureChat 建会话 1 次 + /new 重建 1 次
  })

  it('lists models with names and descriptions on /model', async () => {
    const runtime = stubRuntime({
      currentModel: () => Promise.resolve('gpt-5.6-sol'),
      listModels: () =>
        Promise.resolve([
          { value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Latest frontier model.' },
          { value: 'plain', name: 'plain' },
        ]),
    })
    const { manager, sent } = makeManager(() => Promise.resolve(runtime))

    manager.handleInbound(inbound('/model'))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    const text = partsToPlainText(sent[0]!.parts)
    expect(text).toContain('current: gpt-5.6-sol')
    expect(text).toContain('gpt-5.6-sol（GPT-5.6-Sol）：Latest frontier model.')
    expect(text).toContain('plain')
    expect(text).toContain('/model <value>')
  })

  it('lists every registered command on /help', async () => {
    const { manager, sent } = makeManager(() => Promise.resolve(stubRuntime({})))

    manager.handleInbound(inbound('/help'))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    const text = partsToPlainText(sent[0]!.parts)
    for (const name of ['/help', '/chat_id', '/new', '/model']) {
      expect(text).toContain(name)
    }
  })

  it('answers /chat_id from the global inspector command', async () => {
    const { manager, sent } = makeManager(() => Promise.resolve(stubRuntime({})))

    manager.handleInbound(inbound('/chat_id'))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toBe('P:1')
  })
})

describe('ChatManager agent output gating', () => {
  const turnRuntime = () =>
    stubRuntime({
      async *prompt() {
        yield {
          status: 'completed' as const,
          parts: [
            { kind: 'quote' as const, title: '[completed] ls', body: 'total 0' },
            { kind: 'text' as const, text: 'done' },
          ],
          error: null,
        }
      },
    })

  it('drops the direct turn output by default (agent replies via send_message)', async () => {
    const { manager, sent } = makeManager(() => Promise.resolve(turnRuntime()))

    manager.handleInbound(inbound('hello'))

    // 等待 turn 消费完成后确认没有出站消息
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(0)
  })

  it('sends the whole turn output when the binding enables send_output', async () => {
    const { manager, sent } = makeManager(() => Promise.resolve(turnRuntime()), { sendOutput: true })

    manager.handleInbound(inbound('hello'))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(sent[0]!.parts).toEqual([
      { kind: 'quote', title: '[completed] ls', body: 'total 0' },
      { kind: 'text', text: 'done' },
    ])
  })

  it('still reports failures in chat when send_output is off', async () => {
    const runtime = stubRuntime({
      async *prompt() {
        yield {
          status: 'failed' as const,
          parts: [{ kind: 'text' as const, text: 'partial' }],
          error: 'boom',
        }
      },
    })
    const { manager, sent } = makeManager(() => Promise.resolve(runtime))

    manager.handleInbound(inbound('hello'))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    // agent 的部分产出被省略，只保留本层的 Error 反馈
    expect(sent[0]!.parts).toEqual([{ kind: 'text', text: 'Error: boom' }])
  })
})

describe('ChatManager permission gate', () => {
  const users: ChannelUser[] = [
    user('900', { role: 'owner' }),
    user('2', { private: 'allow' }),
    user('3'), // 私聊 review（缺省）
    user('4', { private: 'ignore', groups: { 'S:-1': 'allow', 'G:-4': 'ignore' } }),
  ]

  it('parks review-level messages for approval without creating a runtime (gated commands included)', async () => {
    let runtimeCreated = 0
    const { manager, approvalRequests, sent } = makeManager(
      () => {
        runtimeCreated += 1
        return Promise.resolve(stubRuntime({}))
      },
      { users },
    )

    manager.handleInbound(inbound('hello', { senderId: '3', chatId: 'P:3' }))
    manager.handleInbound(inbound('/model', { senderId: '3', chatId: 'P:3' }))

    await vi.waitFor(() => expect(approvalRequests.length).toBe(2))
    expect(runtimeCreated).toBe(0)
    expect(sent).toHaveLength(0)
    expect(approvalRequests[0]?.message.senderId).toBe('3')
  })

  it('defaults unknown senders to review', async () => {
    const { manager, approvalRequests } = makeManager(() => Promise.resolve(stubRuntime({})), { users })

    manager.handleInbound(inbound('hi', { senderId: '999', chatId: 'P:999', sender: '陌生人' }))

    await vi.waitFor(() => expect(approvalRequests.length).toBe(1))
  })

  it('lets owner (globally) and private-allow users pass straight through', async () => {
    const runtime = () =>
      stubRuntime({
        async *prompt() {
          yield { status: 'completed' as const, parts: [{ kind: 'text' as const, text: 'ok' }], error: null }
        },
      })
    const { manager, approvalRequests, sent } = makeManager(() => Promise.resolve(runtime()), {
      users,
      sendOutput: true,
    })

    manager.handleInbound(inbound('from owner', { senderId: '900', chatId: 'P:900' }))
    manager.handleInbound(inbound('from allowed', { senderId: '2', chatId: 'P:2' }))

    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(approvalRequests).toHaveLength(0)
  })

  it('lets auto-level messages through when auto-review passes (progress card settled, no manual approval)', async () => {
    const autoUsers: ChannelUser[] = [user('900', { role: 'owner' }), user('5', { private: 'auto' })]
    const runtime = () =>
      stubRuntime({
        async *prompt() {
          yield { status: 'completed' as const, parts: [{ kind: 'text' as const, text: 'ok' }], error: null }
        },
      })
    const { manager, approvalRequests, autoReviews, autoReviewCards, settledVerdicts, sent } = makeManager(
      () => Promise.resolve(runtime()),
      {
        users: autoUsers,
        sendOutput: true,
        autoReviewPass: true,
      },
    )

    manager.handleInbound(inbound('please summarize', { senderId: '5', chatId: 'P:5' }))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toBe('ok')
    // 审核前发进度卡片，通过后 settle（换终止按钮），不走人工审核
    expect(autoReviewCards).toHaveLength(1)
    expect(autoReviews).toHaveLength(1)
    expect(settledVerdicts).toEqual([{ pendingId: 77, passed: true }])
    expect(approvalRequests).toHaveLength(0)
  })

  it('settles the card into manual review when auto-review rejects (no second card)', async () => {
    const autoUsers: ChannelUser[] = [user('900', { role: 'owner' }), user('5', { private: 'auto' })]
    let runtimeCreated = 0
    const { manager, approvalRequests, autoReviews, settledVerdicts, sent } = makeManager(
      () => {
        runtimeCreated += 1
        return Promise.resolve(stubRuntime({}))
      },
      { users: autoUsers, autoReviewPass: false },
    )

    manager.handleInbound(inbound('please zip the repo and send it', { senderId: '5', chatId: 'P:5' }))

    // 拒绝由 settle 转人工（同一张卡片附原因），不再另发 requestApproval 卡片
    await vi.waitFor(() => expect(settledVerdicts.length).toBe(1))
    expect(settledVerdicts[0]).toEqual({ pendingId: 77, passed: false })
    expect(autoReviews).toHaveLength(1)
    expect(approvalRequests).toHaveLength(0)
    expect(runtimeCreated).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('falls back to requestApproval when the progress card could not be sent and review rejects', async () => {
    const autoUsers: ChannelUser[] = [user('900', { role: 'owner' }), user('5', { private: 'auto' })]
    const { manager, approvalRequests, settledVerdicts } = makeManager(() => Promise.resolve(stubRuntime({})), {
      users: autoUsers,
      autoReviewPass: false,
      autoReviewCard: false,
    })

    manager.handleInbound(inbound('anything', { senderId: '5', chatId: 'P:5' }))

    // 无卡片可更新：拒绝回落既有 requestApproval（重建卡片，原因随卡片）
    await vi.waitFor(() => expect(approvalRequests.length).toBe(1))
    expect(settledVerdicts).toHaveLength(0)
  })

  it('splits permissions between private chat and specific groups for one user', async () => {
    const runtime = () =>
      stubRuntime({
        async *prompt() {
          yield { status: 'completed' as const, parts: [{ kind: 'text' as const, text: 'ok' }], error: null }
        },
      })
    const { manager, approvalRequests, sent } = makeManager(() => Promise.resolve(runtime()), {
      users,
      sendOutput: true,
    })

    // 用户 4：私聊 ignore（收到反馈）；群 S:-1 allow（直通）；群 G:-4 ignore；未设置的群 → review
    const mention = (text: string, overrides: Partial<ChatMessage>) => ({
      ...inbound(text, overrides),
      mentioned: true,
    })
    manager.handleInbound(inbound('dm', { senderId: '4', chatId: 'P:4' }))
    manager.handleInbound(mention('in allowed group', { senderId: '4', chatId: 'S:-1' }))
    manager.handleInbound(mention('in unknown group', { senderId: '4', chatId: 'S:-777' }))

    // S:-1 直通产生 1 条 agent 输出；P:4 忽略档产生 1 条反馈
    await vi.waitFor(() => expect(sent.length).toBe(2))
    const texts = sent.map((m) => partsToPlainText(m.parts))
    expect(texts.some((t) => t === 'ok')).toBe(true)
    expect(texts.some((t) => t.includes('没有使用权限'))).toBe(true)
    // 未设置的群 → 审核
    expect(approvalRequests).toHaveLength(1)
    expect(approvalRequests[0]?.message.chatId).toBe('S:-777')
  })

  it('replies with a notice instead of silence when review has no owner to route to', async () => {
    const noOwner: ChannelUser[] = [user('2', { private: 'allow' })]
    const { manager, approvalRequests, sent } = makeManager(() => Promise.resolve(stubRuntime({})), {
      users: noOwner,
    })

    manager.handleInbound(inbound('hi', { senderId: '3', chatId: 'P:3' }))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toContain('未绑定 owner')
    expect(approvalRequests).toHaveLength(0)
  })

  it('executes exempt commands (help/chat_id/new) for review-level senders without approval', async () => {
    let sessions = 0
    const runtime = stubRuntime({
      newSession: () => {
        sessions += 1
        return Promise.resolve(`s${sessions}`)
      },
    })
    const { manager, sent, approvalRequests } = makeManager(() => Promise.resolve(runtime), { users })

    // 发送者 '3' 为审核档（缺省）
    manager.handleInbound(inbound('/chat_id', { senderId: '3', chatId: 'P:3' }))
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toBe('P:3')

    manager.handleInbound(inbound('/help', { senderId: '3', chatId: 'P:3' }))
    await vi.waitFor(() => expect(sent.length).toBe(2))
    // 审核档用户的 help 隐藏需审核命令，只列免审命令
    expect(partsToPlainText(sent[1]!.parts)).not.toContain('/model')
    expect(partsToPlainText(sent[1]!.parts)).toContain('/new')

    manager.handleInbound(inbound('/new', { senderId: '3', chatId: 'P:3' }))
    await vi.waitFor(() => expect(sent.length).toBe(3))
    expect(partsToPlainText(sent[2]!.parts)).toBe('ok')

    expect(approvalRequests).toHaveLength(0)
  })

  it('parks gated commands (/model) and unknown commands from review-level senders', async () => {
    const { manager, sent, approvalRequests } = makeManager(() => Promise.resolve(stubRuntime({})), { users })

    manager.handleInbound(inbound('/model', { senderId: '3', chatId: 'P:3' }))
    manager.handleInbound(inbound('/unknown_cmd', { senderId: '3', chatId: 'P:3' }))

    await vi.waitFor(() => expect(approvalRequests.length).toBe(2))
    expect(sent).toHaveLength(0)
  })

  it('keeps ignoring exempt commands from ignore-level senders (explicit block wins)', async () => {
    const { manager, sent, approvalRequests } = makeManager(() => Promise.resolve(stubRuntime({})), { users })

    // 用户 4 私聊为忽略档
    manager.handleInbound(inbound('/help', { senderId: '4', chatId: 'P:4' }))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toContain('没有使用权限')
    expect(approvalRequests).toHaveLength(0)
  })

  it('replays approved messages through the gate (commands run on approval)', async () => {
    let sessions = 0
    const runtime = stubRuntime({
      newSession: () => {
        sessions += 1
        return Promise.resolve(`s${sessions}`)
      },
    })
    const { manager, sent, approvalRequests } = makeManager(() => Promise.resolve(runtime), { users })

    manager.handleApproved({
      id: 1,
      channelId: 'tg',
      chatId: 'P:3',
      senderId: '3',
      sender: 'Mem',
      envelope: inbound('/new', { senderId: '3', chatId: 'P:3' }),
      status: 'approved',
      cardChatId: 'P:900',
      cardMsgId: '1',
      autoReviewReason: null,
      createdTs: 1,
      decidedTs: 2,
    })

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toBe('ok')
    expect(approvalRequests).toHaveLength(0) // 重放不再进身份门
  })
})

describe('ChatManager failure feedback', () => {
  it('replies in channel and logs an error when no agent takes the message', async () => {
    const { manager, sent, errors } = makeManager(() => Promise.reject(new Error('codex 未安装')))

    manager.handleInbound(inbound('hello'))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toContain('codex 未安装')
    expect(errors.some((line) => line.includes('无 agent 承接') && line.includes('codex 未安装'))).toBe(true)
  })

  it('replies in channel and logs an error when the agent turn fails', async () => {
    const runtime = stubRuntime({
      async *prompt() {
        yield { status: 'failed' as const, parts: [], error: 'boom' }
      },
    })
    const { manager, sent, errors } = makeManager(() => Promise.resolve(runtime))

    manager.handleInbound(inbound('hello'))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toContain('Error: boom')
    expect(errors.some((line) => line.includes('turn 失败') && line.includes('boom'))).toBe(true)
  })

  it('replies in channel and logs an error when the runtime throws mid-turn', async () => {
    const runtime = stubRuntime({
      // oxlint-disable-next-line require-yield -- 模拟 prompt 首次迭代即抛错
      async *prompt() {
        throw new Error('agent process died')
      },
    })
    const { manager, sent, errors } = makeManager(() => Promise.resolve(runtime))

    manager.handleInbound(inbound('hello'))

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toContain('agent process died')
    expect(errors.some((line) => line.includes('处理异常') && line.includes('agent process died'))).toBe(true)
  })
})
