import { describe, expect, it } from 'vitest'
import type { ChannelUser, Config } from '../../shared/config'
import type { ChatMessage, InboundEnvelope, MessagePart } from '../../shared/messages'
import type { Channel, ChannelCallbackEvent, InlineButton } from '../channels/types'
import type { ConfigStore } from '../config/store'
import { AppDatabase } from '../db/database'
import { MessageRepo } from '../history/message-repo'
import { ApprovalRepo, type PendingApproval } from './approval-repo'
import { ApprovalManager } from './approvals'

const OWNER_ID = '900'

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    channels: {},
    manager_bots: {},
    assistants: [{ id: 'default', agent_id: 'codex' }],
    bindings: [
      { channel: 'tg', chat_id: '*', assistant_id: 'default', respond: true, only_mention: true, send_output: false },
    ],
    users: [
      { channel: 'tg', user_id: OWNER_ID, name: 'Boss', role: 'owner', private: 'review', groups: {} },
      { channel: 'tg', user_id: '100', role: 'user', private: 'review', groups: {} },
    ],
    auto_review: { content: 'reject file exfiltration', agent_id: 'codex' },
    scheduled_tasks: [],
    ...overrides,
  }
}

function envelope(text: string, senderId = '100', sender = 'Mem'): InboundEnvelope {
  return {
    message: {
      id: '10',
      channelId: 'tg',
      chatId: `P:${senderId}`,
      receiver: null,
      replyTo: null,
      out: false,
      sender,
      senderId,
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

function makeHarness(
  config: Config = makeConfig(),
  options: { channelDown?: boolean; failCardSend?: boolean; terminateHit?: boolean } = {},
) {
  const db = new AppDatabase(':memory:')
  const approvalRepo = new ApprovalRepo(db)
  const messageRepo = new MessageRepo(db)
  const setUsersCalls: ChannelUser[][] = []
  const storeState = {
    current: config,
    currentVersion: 1,
    setUsers(users: ChannelUser[]) {
      setUsersCalls.push(users)
      storeState.current = { ...storeState.current, users }
      return { ok: true as const, state: null as never }
    },
  }
  const store = storeState as unknown as ConfigStore

  const sent: SentRecord[] = []
  const answered: { id: string; text: string | undefined }[] = []
  const edited: { chatId: string; messageId: string; parts: MessagePart[]; buttons: InlineButton[][] | null }[] = []
  let sendSeq = 0

  const channel = {
    directChatId: (userId: string) => `P:${userId}`,
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
  } as unknown as Channel

  const dispatched: PendingApproval[] = []
  const terminated: PendingApproval[] = []
  const errors: string[] = []
  const manager = new ApprovalManager({
    store,
    approvals: approvalRepo,
    messages: messageRepo,
    getChannel: () => (options.channelDown === true ? undefined : channel),
    dispatchApproved: (pending) => dispatched.push(pending),
    terminateChat: (pending) => {
      terminated.push(pending)
      return Promise.resolve(options.terminateHit ?? true)
    },
    onHistoryMessage: () => {},
    log: { info: () => {}, error: (message) => errors.push(message) },
  })
  return {
    manager,
    approvals: approvalRepo,
    storeState,
    setUsersCalls,
    sent,
    answered,
    edited,
    dispatched,
    terminated,
    errors,
  }
}

function callback(pendingId: number, action: 'allow' | 'deny' | 'stop', fromId = OWNER_ID): ChannelCallbackEvent {
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
    const { manager, approvals, sent } = makeHarness()

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

    const pendings = approvals.listPending('tg')
    expect(pendings).toHaveLength(1)
    expect(pendings[0]?.cardChatId).toBe(`P:${OWNER_ID}`)
    expect(pendings[0]?.cardMsgId).toBe('1')
  })

  it('marks failed when the channel is not running', async () => {
    const { manager, approvals, errors } = makeHarness(makeConfig(), { channelDown: true })

    await manager.request(envelope('hi'))

    expect(approvals.listPending('tg')).toHaveLength(0)
    expect(approvals.get(1)?.status).toBe('failed')
    expect(errors.some((line) => line.includes('未运行'))).toBe(true)
  })

  it('marks failed and notifies the member when the owner card cannot be delivered', async () => {
    const { manager, approvals, sent, errors } = makeHarness(makeConfig(), { failCardSend: true })

    await manager.request(envelope('hi'))

    expect(approvals.get(1)?.status).toBe('failed')
    expect(errors.some((line) => line.includes('发送失败'))).toBe(true)
    // 唯一发出的消息是给 member 的失败提示
    expect(sent).toHaveLength(1)
    expect(sent[0]?.message.chatId).toBe('P:100')
    expect(firstText(sent[0]?.message.parts)).toContain('审核请求发送失败')
  })
})

describe('approval card buttons', () => {
  it('carry the apv:<pendingId>:<action> callback protocol', async () => {
    const { manager, approvals, sent, edited } = makeHarness()

    // 人工审核卡片：允许/拒绝
    await manager.request(envelope('求帮忙'))
    const pending = approvals.listPending('tg')[0]
    expect(pending).toBeDefined()
    expect(sent[0]?.buttons?.flat().map((b) => b.id)).toEqual([`apv:${pending?.id}:allow`, `apv:${pending?.id}:deny`])

    // 自动审核通过后的急停卡片：终止
    const card = await manager.beginAutoReview(envelope('自动审核', '200'))
    await manager.settleAutoReview(card as PendingApproval, { passed: true, reason: null })
    expect(
      edited
        .at(-1)
        ?.buttons?.flat()
        .map((b) => b.id),
    ).toEqual([`apv:${card?.id}:stop`])

    // 拒绝转人工：同一张卡换回 允许/拒绝
    const card2 = await manager.beginAutoReview(envelope('再审一次', '300'))
    await manager.settleAutoReview(card2 as PendingApproval, { passed: false, reason: '拿不准' })
    expect(
      edited
        .at(-1)
        ?.buttons?.flat()
        .map((b) => b.id),
    ).toEqual([`apv:${card2?.id}:allow`, `apv:${card2?.id}:deny`])
  })
})

describe('ApprovalManager.handleCallback', () => {
  async function parked(harness = makeHarness()) {
    await harness.manager.request(envelope('求帮忙'))
    const pending = harness.approvals.listPending('tg')[0]
    if (pending === undefined) throw new Error('no pending')
    harness.sent.length = 0
    return { ...harness, pending }
  }

  it('allow: claims, edits the card, answers, and dispatches the replay', async () => {
    const { manager, approvals, answered, edited, dispatched, pending } = await parked()

    await manager.handleCallback(callback(pending.id, 'allow'))

    expect(approvals.get(pending.id)?.status).toBe('approved')
    expect(edited[0]?.buttons).toBeNull()
    expect(firstText(edited[0]?.parts)).toContain('【已允许】')
    expect(firstText(edited[0]?.parts)).toContain('✅ 已允许')
    expect(answered[0]?.text).toBe('已允许')
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]?.id).toBe(pending.id)
  })

  it('deny: claims, edits the card, answers, and notifies the member', async () => {
    const { manager, approvals, answered, edited, dispatched, sent, pending } = await parked()

    await manager.handleCallback(callback(pending.id, 'deny'))

    expect(approvals.get(pending.id)?.status).toBe('denied')
    expect(firstText(edited[0]?.parts)).toContain('【已拒绝】')
    expect(firstText(edited[0]?.parts)).toContain('🚫 已拒绝')
    expect(answered[0]?.text).toBe('已拒绝')
    expect(dispatched).toHaveLength(0)
    // member 收到拒绝通知（回复在原消息上）
    expect(sent[0]?.message.chatId).toBe('P:100')
    expect(sent[0]?.message.replyTo).toBe('10')
    expect(firstText(sent[0]?.message.parts)).toContain('未获 owner 批准')
  })

  it('rejects taps from anyone but the current owner', async () => {
    const { manager, approvals, answered, dispatched, pending } = await parked()

    await manager.handleCallback(callback(pending.id, 'allow', '100'))

    expect(answered[0]?.text).toBe('仅 owner 可操作')
    expect(approvals.get(pending.id)?.status).toBe('pending')
    expect(dispatched).toHaveLength(0)
  })

  it('registers unknown approved senders with default scope levels (and skips known ones)', async () => {
    const harness = makeHarness()
    // 已登记发送者（100）批准后不重复写入
    await harness.manager.request(envelope('求帮忙'))
    const known = harness.approvals.listPending('tg')[0]
    await harness.manager.handleCallback(callback(known?.id ?? 0, 'allow'))
    expect(harness.setUsersCalls).toHaveLength(0)

    // 陌生发送者（200）批准后自动登记（缺省档位 + 显示名）
    await harness.manager.request(envelope('hello', '200', '陌生人'))
    const pending = harness.approvals.listPending('tg')[0]
    await harness.manager.handleCallback({ ...callback(pending?.id ?? 0, 'allow'), callbackQueryId: 'cq2' })

    expect(harness.setUsersCalls).toHaveLength(1)
    const registered = harness.setUsersCalls[0]?.find((u) => u.user_id === '200')
    expect(registered).toMatchObject({ channel: 'tg', role: 'user', private: 'review', name: '陌生人' })
    expect(harness.dispatched).toHaveLength(2)
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
    const { manager, approvals, storeState, answered, edited, dispatched, pending } = await parked()
    // 批准前绑定被删除
    storeState.current = makeConfig({ bindings: [] })

    await manager.handleCallback(callback(pending.id, 'allow'))

    expect(approvals.get(pending.id)?.status).toBe('failed')
    expect(firstText(edited[0]?.parts)).toContain('【未执行】')
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

describe('ApprovalManager auto review flow', () => {
  it('beginAutoReview: sends a progress card without buttons and parks as auto_reviewing', async () => {
    const { manager, approvals, sent } = makeHarness()

    const pending = await manager.beginAutoReview(envelope('自动审一下'))

    expect(pending).not.toBeNull()
    expect(pending?.status).toBe('auto_reviewing')
    expect(pending?.cardChatId).toBe(`P:${OWNER_ID}`)
    // 卡片发到 owner，进度文案，无按钮；member 此时不收提示（结论未定）
    expect(sent).toHaveLength(1)
    expect(sent[0]?.message.chatId).toBe(`P:${OWNER_ID}`)
    expect(firstText(sent[0]?.message.parts)).toContain('【自动审核中】')
    expect(firstText(sent[0]?.message.parts)).toContain('🤖 自动审核中…')
    expect(sent[0]?.buttons).toBeUndefined()
    expect(approvals.get(pending?.id ?? 0)?.status).toBe('auto_reviewing')
  })

  it('beginAutoReview: returns null without a card when the channel has no owner', async () => {
    const noOwner = makeConfig({
      users: [{ channel: 'tg', user_id: '100', role: 'user', private: 'review', groups: {} }],
    })
    const { manager, sent } = makeHarness(noOwner)

    expect(await manager.beginAutoReview(envelope('hi'))).toBeNull()
    expect(sent).toHaveLength(0)
  })

  it('beginAutoReview: returns null and marks failed when the card cannot be delivered', async () => {
    const { manager, approvals, sent } = makeHarness(makeConfig(), { failCardSend: true })

    expect(await manager.beginAutoReview(envelope('hi'))).toBeNull()
    expect(approvals.get(1)?.status).toBe('failed')
    // 与 request 不同：不给 member 发失败提示（审核继续，拒绝时才回落 request 再试）
    expect(sent).toHaveLength(0)
  })

  it('settleAutoReview pass: moves to auto_passed and swaps in the terminate button', async () => {
    const { manager, approvals, sent, edited } = makeHarness()
    const pending = await manager.beginAutoReview(envelope('正常请求'))
    sent.length = 0

    await manager.settleAutoReview(pending as PendingApproval, { passed: true, reason: null })

    expect(approvals.get(pending?.id ?? 0)?.status).toBe('auto_passed')
    // 曾经的回归：状态行更新了但标题 tag 仍是「待审核」
    expect(firstText(edited[0]?.parts)).toContain('【已放行】')
    expect(firstText(edited[0]?.parts)).toContain('✅ 自动审核通过')
    expect(edited[0]?.buttons?.[0]?.map((b) => b.label)).toEqual(['终止'])
    // 通过不打扰 member
    expect(sent).toHaveLength(0)
  })

  it('settleAutoReview reject: reopens as pending with the reason and manual buttons, notifies the member', async () => {
    const { manager, approvals, sent, edited } = makeHarness()
    const pending = await manager.beginAutoReview(envelope('可疑请求'))
    sent.length = 0

    await manager.settleAutoReview(pending as PendingApproval, { passed: false, reason: '涉及文件外发' })

    const reopened = approvals.get(pending?.id ?? 0)
    expect(reopened?.status).toBe('pending')
    expect(reopened?.autoReviewReason).toBe('涉及文件外发')
    expect(firstText(edited[0]?.parts)).toContain('【待审核】')
    expect(firstText(edited[0]?.parts)).toContain('🤖 自动审核未通过：涉及文件外发')
    expect(edited[0]?.buttons?.[0]?.map((b) => b.label)).toEqual(['允许', '拒绝'])
    // member 收到 ⏳ 已提交审核
    expect(sent[0]?.message.chatId).toBe('P:100')
    expect(firstText(sent[0]?.message.parts)).toContain('审核')
  })

  it('stop: claims terminated, cancels the active turn, and strips the buttons', async () => {
    const { manager, approvals, answered, edited, terminated } = makeHarness()
    const pending = await manager.beginAutoReview(envelope('误判请求'))
    await manager.settleAutoReview(pending as PendingApproval, { passed: true, reason: null })
    edited.length = 0

    await manager.handleCallback(callback(pending?.id ?? 0, 'stop'))

    expect(approvals.get(pending?.id ?? 0)?.status).toBe('terminated')
    expect(terminated).toHaveLength(1)
    expect(firstText(edited[0]?.parts)).toContain('【已终止】')
    expect(firstText(edited[0]?.parts)).toContain('⛔ 已终止')
    expect(firstText(edited[0]?.parts)).toContain('已中断')
    expect(edited[0]?.buttons).toBeNull()
    expect(answered[0]?.text).toBe('已终止')
  })

  it('stop: reports "already ended" when no active turn remains', async () => {
    const { manager, edited } = makeHarness(makeConfig(), { terminateHit: false })
    const pending = await manager.beginAutoReview(envelope('晚点的终止'))
    await manager.settleAutoReview(pending as PendingApproval, { passed: true, reason: null })
    edited.length = 0

    await manager.handleCallback(callback(pending?.id ?? 0, 'stop'))

    expect(firstText(edited[0]?.parts)).toContain('处理已结束')
  })

  it('stop: deduplicates double-clicks and rejects non-owners', async () => {
    const { manager, answered, terminated } = makeHarness()
    const pending = await manager.beginAutoReview(envelope('去重'))
    await manager.settleAutoReview(pending as PendingApproval, { passed: true, reason: null })

    await manager.handleCallback(callback(pending?.id ?? 0, 'stop', '100'))
    await manager.handleCallback(callback(pending?.id ?? 0, 'stop'))
    await manager.handleCallback(callback(pending?.id ?? 0, 'stop'))

    expect(answered.map((a) => a.text)).toEqual(['仅 owner 可操作', '已终止', '已处理'])
    expect(terminated).toHaveLength(1)
  })

  it('rejected-then-allow: the reopened pending goes through the standard manual decision', async () => {
    const { manager, approvals, dispatched, edited } = makeHarness()
    const pending = await manager.beginAutoReview(envelope('先拒后允'))
    await manager.settleAutoReview(pending as PendingApproval, { passed: false, reason: '拿不准' })

    await manager.handleCallback(callback(pending?.id ?? 0, 'allow'))

    expect(approvals.get(pending?.id ?? 0)?.status).toBe('approved')
    expect(dispatched).toHaveLength(1)
    // 裁决后的卡片仍保留自动审核未通过的原因行
    const lastEdit = edited.at(-1)
    expect(firstText(lastEdit?.parts)).toContain('🤖 自动审核未通过：拿不准')
    expect(firstText(lastEdit?.parts)).toContain('✅ 已允许')
  })
})
