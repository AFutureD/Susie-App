import { describe, expect, it } from 'vitest'
import type { Config } from '../../shared/config'
import type { ChatMessage, InboundEnvelope, MessagePart } from '../../shared/messages'
import type { ChannelCallbackEvent, InlineButton, TelegramBotChannel } from '../channels/telegram-bot'
import type { ConfigStore } from '../config/store'
import { HistoryStore, type PendingApproval } from '../history/store'
import { ApprovalManager } from './approvals'

const OWNER_ID = '900'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    channels: {},
    assistants: [{ id: 'default', agent_id: 'codex' }],
    bindings: [
      { channel: 'tg', chat_id: '*', assistant_id: 'default', only_mention: true, members: [], send_output: false },
    ],
    users: [
      { channel: 'tg', user_id: OWNER_ID, name: 'Boss', role: 'owner' },
      { channel: 'tg', user_id: '100', role: 'member' },
    ],
    ...overrides,
  }
}

function envelope(text: string): InboundEnvelope {
  return {
    message: {
      id: '10',
      channelId: 'tg',
      chatId: 'P:100',
      receiver: null,
      replyTo: null,
      out: false,
      sender: 'Mem',
      senderId: '100',
      timestamp: 1,
      parts: [{ kind: 'text', text }],
    },
    chatName: '客厅',
    mentioned: false,
  }
}

interface SentRecord {
  message: ChatMessage
  buttons: InlineButton[][] | undefined
}

function makeHarness(config: Config = makeConfig(), options: { channelDown?: boolean; failCardSend?: boolean } = {}) {
  const history = new HistoryStore(':memory:')
  const storeState = { current: config }
  const store = storeState as unknown as ConfigStore

  const sent: SentRecord[] = []
  const answered: { id: string; text: string | undefined }[] = []
  const edited: { chatId: string; messageId: string; parts: MessagePart[]; buttons: InlineButton[][] | null }[] = []
  let sendSeq = 0

  const channel = {
    sendMessage: (message: ChatMessage, opts?: { buttons?: InlineButton[][] }) => {
      if (options.failCardSend === true && message.chatId === `P:${OWNER_ID}`) {
        return Promise.reject(new Error('403 Forbidden: bot was blocked'))
      }
      sent.push({ message, buttons: opts?.buttons })
      sendSeq += 1
      return Promise.resolve({ ...message, id: String(sendSeq) })
    },
    answerCallback: (id: string, text?: string) => {
      answered.push({ id, text })
      return Promise.resolve()
    },
    editMessage: (chatId: string, messageId: string, parts: MessagePart[], buttons: InlineButton[][] | null) => {
      edited.push({ chatId, messageId, parts, buttons })
      return Promise.resolve()
    },
  } as unknown as TelegramBotChannel

  const dispatched: PendingApproval[] = []
  const errors: string[] = []
  const manager = new ApprovalManager({
    store,
    history,
    getChannel: () => (options.channelDown === true ? undefined : channel),
    dispatchApproved: (pending) => dispatched.push(pending),
    onHistoryMessage: () => {},
    log: { info: () => {}, error: (message) => errors.push(message) },
  })
  return { manager, history, storeState, sent, answered, edited, dispatched, errors }
}

function callback(pendingId: number, action: 'allow' | 'deny', fromId = OWNER_ID): ChannelCallbackEvent {
  return {
    channelId: 'tg',
    callbackQueryId: 'cq1',
    fromId,
    data: `apv:${pendingId}:${action}`,
    chatId: `P:${OWNER_ID}`,
    messageId: '1',
  }
}

/** 断言辅助：取消息 parts 首段文本 */
function firstText(parts: MessagePart[] | undefined): string {
  const part = parts?.[0]
  return part !== undefined && part.kind === 'text' ? part.text : ''
}

describe('ApprovalManager.request', () => {
  it('parks the message, sends the owner card with buttons, and notifies the member', async () => {
    const { manager, history, sent } = makeHarness()

    await manager.request(envelope('求帮忙'))

    // 卡片发到 owner 私聊，带 允许/拒绝 按钮
    expect(sent[0]?.message.chatId).toBe(`P:${OWNER_ID}`)
    const cardText = firstText(sent[0]?.message.parts)
    expect(cardText).toContain('【待审核】')
    expect(cardText).toContain('Mem')
    expect(cardText).toContain('客厅')
    expect(cardText).toContain('求帮忙')
    expect(sent[0]?.buttons?.[0]?.map((b) => b.label)).toEqual(['允许', '拒绝'])

    // member 收到「已提交审核」，回复在原消息上
    expect(sent[1]?.message.chatId).toBe('P:100')
    expect(sent[1]?.message.replyTo).toBe('10')
    expect(firstText(sent[1]?.message.parts)).toContain('审核')

    const pendings = history.listPendingApprovals('tg')
    expect(pendings).toHaveLength(1)
    expect(pendings[0]?.cardChatId).toBe(`P:${OWNER_ID}`)
    expect(pendings[0]?.cardMsgId).toBe('1')
  })

  it('marks failed when the channel is not running', async () => {
    const { manager, history, errors } = makeHarness(makeConfig(), { channelDown: true })

    await manager.request(envelope('hi'))

    expect(history.listPendingApprovals('tg')).toHaveLength(0)
    expect(history.getPendingApproval(1)?.status).toBe('failed')
    expect(errors.some((line) => line.includes('未运行'))).toBe(true)
  })

  it('marks failed and notifies the member when the owner card cannot be delivered', async () => {
    const { manager, history, sent, errors } = makeHarness(makeConfig(), { failCardSend: true })

    await manager.request(envelope('hi'))

    expect(history.getPendingApproval(1)?.status).toBe('failed')
    expect(errors.some((line) => line.includes('发送失败'))).toBe(true)
    // 唯一发出的消息是给 member 的失败提示
    expect(sent).toHaveLength(1)
    expect(sent[0]?.message.chatId).toBe('P:100')
    expect(firstText(sent[0]?.message.parts)).toContain('审核请求发送失败')
  })
})

describe('ApprovalManager.handleCallback', () => {
  async function parked(harness = makeHarness()) {
    await harness.manager.request(envelope('求帮忙'))
    const pending = harness.history.listPendingApprovals('tg')[0]
    if (pending === undefined) throw new Error('no pending')
    harness.sent.length = 0
    return { ...harness, pending }
  }

  it('allow: claims, edits the card, answers, and dispatches the replay', async () => {
    const { manager, history, answered, edited, dispatched, pending } = await parked()

    await manager.handleCallback(callback(pending.id, 'allow'))

    expect(history.getPendingApproval(pending.id)?.status).toBe('approved')
    expect(edited[0]?.buttons).toBeNull()
    expect(firstText(edited[0]?.parts)).toContain('✅ 已允许')
    expect(answered[0]?.text).toBe('已允许')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.id).toBe(pending.id)
  })

  it('deny: claims, edits the card, answers, and notifies the member', async () => {
    const { manager, history, answered, edited, dispatched, sent, pending } = await parked()

    await manager.handleCallback(callback(pending.id, 'deny'))

    expect(history.getPendingApproval(pending.id)?.status).toBe('denied')
    expect(firstText(edited[0]?.parts)).toContain('🚫 已拒绝')
    expect(answered[0]?.text).toBe('已拒绝')
    expect(dispatched).toHaveLength(0)
    // member 收到拒绝通知（回复在原消息上）
    expect(sent[0]?.message.chatId).toBe('P:100')
    expect(sent[0]?.message.replyTo).toBe('10')
    expect(firstText(sent[0]?.message.parts)).toContain('未获 owner 批准')
  })

  it('rejects taps from anyone but the current owner', async () => {
    const { manager, history, answered, dispatched, pending } = await parked()

    await manager.handleCallback(callback(pending.id, 'allow', '100'))

    expect(answered[0]?.text).toBe('仅 owner 可操作')
    expect(history.getPendingApproval(pending.id)?.status).toBe('pending')
    expect(dispatched).toHaveLength(0)
  })

  it('deduplicates double-clicks: only the first claim wins', async () => {
    const { manager, answered, dispatched, pending } = await parked()

    await manager.handleCallback(callback(pending.id, 'allow'))
    await manager.handleCallback(callback(pending.id, 'allow'))
    await manager.handleCallback(callback(pending.id, 'deny'))

    expect(dispatched).toHaveLength(1)
    expect(answered.map((a) => a.text)).toEqual(['已允许', '已处理', '已处理'])
  })

  it('fails the approval when the binding vanished before allow', async () => {
    const { manager, history, storeState, answered, edited, dispatched, pending } = await parked()
    // 批准前绑定被删除
    storeState.current = makeConfig({ bindings: [] })

    await manager.handleCallback(callback(pending.id, 'allow'))

    expect(history.getPendingApproval(pending.id)?.status).toBe('failed')
    expect(firstText(edited[0]?.parts)).toContain('绑定已失效')
    expect(answered[0]?.text).toBe('绑定已失效，未执行')
    expect(dispatched).toHaveLength(0)
  })

  it('answers politely on unknown callback data and unknown pending ids', async () => {
    const { manager, answered } = makeHarness()

    await manager.handleCallback({ ...callback(1, 'allow'), data: 'other:stuff' })
    expect(answered[0]?.text).toBeUndefined()

    await manager.handleCallback(callback(999, 'allow'))
    expect(answered[1]?.text).toContain('不存在')
  })
})
