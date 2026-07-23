import { describe, expect, it, vi } from 'vitest'
import type { AssistantConfig, Config } from '../../shared/config'
import { partsToPlainText, type ChatMessage, type StoredMessage } from '../../shared/messages'
import type { AgentRuntime } from '../agents/types'
import type { InboundEnvelope, TelegramBotChannel } from '../channels/telegram-bot'
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

function makeManager(createRuntime: (assistant: AssistantConfig) => Promise<AgentRuntime>) {
  const config: Config = {
    channels: {},
    assistants: [{ id: 'default', agent_id: 'codex' }],
    bindings: [{ channel: 'tg', chat_id: '*', assistant_id: 'default', only_mention: true, members: [] }],
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
  const manager = new ChatManager({
    store,
    history,
    mcpName: 'susie',
    getChannel: () => channel,
    createRuntime,
    onHistoryMessage: () => {},
    log: { info: () => {}, error: (message) => errors.push(message) },
  })
  return { manager, sent, errors }
}

function inbound(text: string): InboundEnvelope {
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
