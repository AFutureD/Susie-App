import { describe, expect, it, vi } from 'vitest'
import type { AssistantConfig, ChannelUser, Config } from '../../shared/config'
import { partsToPlainText, type ChatMessage, type InboundEnvelope, type StoredMessage } from '../../shared/messages'
import type { AgentRuntime } from '../agents/types'
import type { TelegramBotChannel } from '../channels/telegram-bot'
import type { ConfigStore } from '../config/store'
import type { HistoryStore } from '../history/store'
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

const makeCtx = (replies: string[]): CommandContext => ({
  channelId: 'c',
  chatId: 'x',
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

/** 默认名单：发送者 '1' 是 owner（既有用例的消息一律直通角色门） */
const DEFAULT_USERS: ChannelUser[] = [{ channel: 'tg', user_id: '1', role: 'owner' }]

function makeManager(
  createRuntime: (assistant: AssistantConfig) => Promise<AgentRuntime>,
  options: { sendOutput?: boolean; users?: ChannelUser[] } = {},
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
        members: [],
        send_output: options.sendOutput ?? false,
      },
    ],
    users: options.users ?? DEFAULT_USERS,
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
    log: { info: (message) => infos.push(message), error: (message) => errors.push(message) },
  })
  return { manager, sent, errors, infos, approvalRequests }
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
  it('exposes the full command catalog for channel menu registration', () => {
    const { manager } = makeManager(() => Promise.reject(new Error('unused')))
    const names = manager.listCommandSpecs().map((spec) => spec.name)
    expect(names.toSorted()).toEqual(['chat_id', 'help', 'model', 'new'])
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

describe('ChatManager role gate', () => {
  const users: ChannelUser[] = [
    { channel: 'tg', user_id: '900', role: 'owner' },
    { channel: 'tg', user_id: '2', role: 'admin' },
    { channel: 'tg', user_id: '3', role: 'member' },
  ]

  it('parks member messages for approval without creating a runtime (commands included)', async () => {
    let runtimeCreated = 0
    const { manager, approvalRequests, sent } = makeManager(
      () => {
        runtimeCreated += 1
        return Promise.resolve(stubRuntime({}))
      },
      { users },
    )

    manager.handleInbound(inbound('hello', { senderId: '3', chatId: 'P:3' }))
    manager.handleInbound(inbound('/new', { senderId: '3', chatId: 'P:3' }))

    await vi.waitFor(() => expect(approvalRequests.length).toBe(2))
    expect(runtimeCreated).toBe(0)
    expect(sent).toHaveLength(0)
    expect(approvalRequests[0]?.message.senderId).toBe('3')
  })

  it('parks unknown senders as members', async () => {
    const { manager, approvalRequests } = makeManager(() => Promise.resolve(stubRuntime({})), { users })

    manager.handleInbound(inbound('hi', { senderId: '999', chatId: 'P:999', sender: '陌生人' }))

    await vi.waitFor(() => expect(approvalRequests.length).toBe(1))
  })

  it('lets owner and admin pass straight through', async () => {
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
    manager.handleInbound(inbound('from admin', { senderId: '2', chatId: 'P:2' }))

    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(approvalRequests).toHaveLength(0)
  })

  it('ignores member messages when the channel has no owner (nobody can review)', async () => {
    const noOwner: ChannelUser[] = [{ channel: 'tg', user_id: '2', role: 'admin' }]
    const { manager, approvalRequests, infos } = makeManager(() => Promise.resolve(stubRuntime({})), {
      users: noOwner,
    })

    manager.handleInbound(inbound('hi', { senderId: '3', chatId: 'P:3' }))

    await vi.waitFor(() => expect(infos.some((line) => line.includes('未绑定 owner'))).toBe(true))
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
      createdTs: 1,
      decidedTs: 2,
    })

    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(partsToPlainText(sent[0]!.parts)).toBe('ok')
    expect(approvalRequests).toHaveLength(0) // 重放不再进审核门
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
