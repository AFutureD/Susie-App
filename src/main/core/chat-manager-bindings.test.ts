import { describe, expect, it, vi } from 'vitest'
import type { ChatBinding, Config } from '../../shared/config'
import { partsToPlainText, type ChatMessage, type InboundEnvelope, type StoredMessage } from '../../shared/messages'
import type { AgentRuntime } from '../agents/types'
import type { Channel } from '../channels/types'
import type { ConfigStore } from '../config/store'
import type { MessageRepo } from '../history/message-repo'
import { ChatManager } from './chat-manager'

// bindings 变更的按会话失效 spec（D3 行为变更）：
// 无关绑定变更 → 会话存活（runtime 不重建）；本会话路由结论变化/绑定删除 → 会话失效。

function binding(overrides: Partial<ChatBinding> = {}): ChatBinding {
  return {
    channel: 'tg',
    chat_id: '*',
    assistant_id: 'default',
    respond: true,
    only_mention: true,
    send_output: true,
    ...overrides,
  }
}

function makeHarness(initialBindings: ChatBinding[]) {
  const config: Config = {
    channels: {},
    manager_bots: {},
    assistants: [
      { id: 'default', agent_id: 'codex' },
      { id: 'other', agent_id: 'codex' },
    ],
    bindings: initialBindings,
    // '1' 是渠道 owner（respond 静音对其不生效）；'2' 是直通普通用户（静音语义用它验证）
    users: [
      { channel: 'tg', user_id: '1', role: 'owner', private: 'review', groups: {} },
      { channel: 'tg', user_id: '2', role: 'user', private: 'allow', groups: {} },
    ],
    auto_review: { content: 'x', agent_id: 'codex' },
    scheduled_tasks: [],
  }
  const listeners = new Map<string, (next: unknown, prev: unknown) => void>()
  const store = {
    get current() {
      return config
    },
    subscribePath: (path: string, listener: (next: unknown, prev: unknown) => void) => {
      listeners.set(path, listener)
      return () => listeners.delete(path)
    },
  } as unknown as ConfigStore

  const setBindings = (next: ChatBinding[]) => {
    const prev = config.bindings
    config.bindings = next
    listeners.get('bindings')?.(next, prev)
  }

  let runtimeCreated = 0
  const makeRuntime = (): AgentRuntime => ({
    newSession: () => Promise.resolve('s'),
    listModels: () => Promise.resolve([]),
    currentModel: () => Promise.resolve(null),
    setModel: () => Promise.resolve(false),
    cancel: () => Promise.resolve(),
    async *prompt() {
      yield { status: 'completed' as const, parts: [{ kind: 'text' as const, text: 'ok' }], error: null }
    },
    dispose: () => Promise.resolve(),
  })

  const sent: ChatMessage[] = []
  const manager = new ChatManager({
    store,
    messages: {
      record: (message: ChatMessage) => ({ ...message, rowid: 1 }) as StoredMessage,
    } as unknown as MessageRepo,
    mcpName: 'susie',
    getChannel: () =>
      ({
        sendMessage: (message: ChatMessage) => {
          sent.push(message)
          return Promise.resolve({ ...message, id: '1' })
        },
        beginTyping: () => () => {},
      }) as unknown as Channel,
    createRuntime: () => {
      runtimeCreated += 1
      return Promise.resolve(makeRuntime())
    },
    onHistoryMessage: () => {},
    requestApproval: () => Promise.resolve(),
    autoReview: () => Promise.resolve({ passed: true, reason: null }),
    beginAutoReview: () => Promise.resolve(null),
    settleAutoReview: () => Promise.resolve(),
    log: { info: () => {}, error: () => {} },
  })

  const inbound = (text: string, senderId = '1'): InboundEnvelope => ({
    message: {
      id: '10',
      channelId: 'tg',
      chatId: 'P:1',
      receiver: null,
      replyTo: null,
      out: false,
      sender: 'user',
      senderId,
      timestamp: 1,
      parts: [{ kind: 'text', text }],
    },
    chatName: null,
    mentioned: false,
  })

  return { manager, sent, setBindings, inbound, runtimeCount: () => runtimeCreated }
}

describe('ChatManager bindings 按会话失效', () => {
  it('无关绑定变更：会话存活，runtime 不重建', async () => {
    const { manager, sent, setBindings, inbound, runtimeCount } = makeHarness([binding()])

    manager.handleInbound(inbound('first'))
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(runtimeCount()).toBe(1)

    // 给另一个会话加精确绑定：本会话（P:1 经 '*' 命中 default）路由结论不变
    setBindings([binding(), binding({ chat_id: 'G:9', assistant_id: 'other' })])

    manager.handleInbound(inbound('second'))
    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(runtimeCount()).toBe(1)
  })

  it('本会话 assistant 变化：会话失效，下条消息重建', async () => {
    const { manager, sent, setBindings, inbound, runtimeCount } = makeHarness([binding()])

    manager.handleInbound(inbound('first'))
    await vi.waitFor(() => expect(sent.length).toBe(1))

    // 精确绑定把 P:1 指到 other：路由结论变化
    setBindings([binding(), binding({ chat_id: 'P:1', assistant_id: 'other' })])

    manager.handleInbound(inbound('second'))
    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(runtimeCount()).toBe(2)
    expect(partsToPlainText(sent[1]!.parts)).toBe('ok')
  })

  it('绑定删除（路由落空）：会话失效且不再响应', async () => {
    const { manager, sent, setBindings, inbound, runtimeCount } = makeHarness([binding()])

    manager.handleInbound(inbound('first'))
    await vi.waitFor(() => expect(sent.length).toBe(1))

    setBindings([])

    manager.handleInbound(inbound('second'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(1)
    expect(runtimeCount()).toBe(1)
  })

  it('respond 翻转：静音即时生效但 runtime 不销毁，恢复后继续用原会话', async () => {
    const { manager, sent, setBindings, inbound, runtimeCount } = makeHarness([binding()])

    manager.handleInbound(inbound('first', '2'))
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(runtimeCount()).toBe(1)

    // 静音：respond=false 是现读过滤器，不销毁会话（保留 agent 上下文）；用非 owner 验证（owner 直通）
    setBindings([binding({ respond: false })])
    manager.handleInbound(inbound('muted', '2'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(1)
    expect(runtimeCount()).toBe(1)

    // 恢复：原会话继续响应，不重建 runtime
    setBindings([binding()])
    manager.handleInbound(inbound('back', '2'))
    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(runtimeCount()).toBe(1)
  })

  it('精确绑定跟随通道默认：通道默认换助手时会话失效重建', async () => {
    const follow = binding({ chat_id: 'P:1', assistant_id: undefined })
    const { manager, sent, setBindings, inbound, runtimeCount } = makeHarness([follow, binding()])

    manager.handleInbound(inbound('first'))
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(runtimeCount()).toBe(1)

    // wildcard 助手 default → other：P:1 的有效助手随 fallback 变化
    setBindings([follow, binding({ assistant_id: 'other' })])
    manager.handleInbound(inbound('second'))
    await vi.waitFor(() => expect(sent.length).toBe(2))
    expect(runtimeCount()).toBe(2)
  })

  it('通道默认不响应但精确绑定开启：仅列出的会话响应', async () => {
    const { manager, sent, inbound, runtimeCount } = makeHarness([
      binding({ respond: false }),
      binding({ chat_id: 'P:1', assistant_id: undefined }),
    ])

    // P:1 有精确绑定（respond 默认 true，助手跟随通道默认）→ 普通用户也响应
    manager.handleInbound(inbound('hello', '2'))
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(runtimeCount()).toBe(1)
  })

  it('通道默认不响应：未列出的会话对普通用户静默', async () => {
    const { manager, sent, inbound, runtimeCount } = makeHarness([binding({ respond: false })])

    manager.handleInbound(inbound('hello', '2'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(sent).toHaveLength(0)
    expect(runtimeCount()).toBe(0)
  })

  it('owner 直通：respond=false 时渠道仍响应 owner 本人', async () => {
    const { manager, sent, inbound, runtimeCount } = makeHarness([binding({ respond: false })])

    manager.handleInbound(inbound('hello', '1'))
    await vi.waitFor(() => expect(sent.length).toBe(1))
    expect(runtimeCount()).toBe(1)
  })
})
