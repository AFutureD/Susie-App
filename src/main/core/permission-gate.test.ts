import { describe, expect, it } from 'vitest'
import type { ChannelUser, Config } from '../../shared/config'
import type { ChatMessage, InboundEnvelope } from '../../shared/messages'
import type { ConfigStore } from '../config/store'
import type { PendingApproval } from './approval-repo'
import type { AutoReviewVerdict } from './auto-review'
import { PermissionGate, type GateInput } from './permission-gate'

// 身份门判定矩阵的直测（脱离 ChatManager；集成路径由 core.test.ts 护航）。

const user = (userId: string, extra: Partial<ChannelUser> = {}): ChannelUser => ({
  channel: 'tg',
  user_id: userId,
  role: 'user',
  private: 'review',
  groups: {},
  ...extra,
})

function makeGate(options: {
  users: ChannelUser[]
  gated?: Record<string, boolean>
  verdict?: AutoReviewVerdict
  card?: boolean
}) {
  const store = { current: { users: options.users } as Config } as unknown as ConfigStore
  const replies: string[] = []
  const approvals: { envelope: InboundEnvelope; reason: string | null }[] = []
  const reviews: InboundEnvelope[] = []
  const cards: InboundEnvelope[] = []
  const settled: { pendingId: number; passed: boolean }[] = []

  const pendingCard: PendingApproval = {
    id: 7,
    channelId: 'tg',
    chatId: 'P:3',
    senderId: '3',
    sender: 'Mem',
    envelope: null as unknown as InboundEnvelope,
    status: 'auto_reviewing',
    cardChatId: 'P:900',
    cardMsgId: '1',
    autoReviewReason: null,
    createdTs: 1,
    decidedTs: null,
  }

  const gate = new PermissionGate({
    store,
    isCommandGated: (name) => options.gated?.[name] ?? true,
    requestApproval: (envelope, opts) => {
      approvals.push({ envelope, reason: opts?.autoReviewReason ?? null })
      return Promise.resolve()
    },
    autoReview: (envelope) => {
      reviews.push(envelope)
      return Promise.resolve(options.verdict ?? { passed: true, reason: null })
    },
    beginAutoReview: (envelope) => {
      cards.push(envelope)
      return Promise.resolve(options.card === false ? null : pendingCard)
    },
    settleAutoReview: (pending, verdict) => {
      settled.push({ pendingId: pending.id, passed: verdict.passed })
      return Promise.resolve()
    },
    reply: (_source, text) => {
      replies.push(text)
      return Promise.resolve()
    },
    log: { info: () => {}, error: () => {} },
  })
  return { gate, replies, approvals, reviews, cards, settled }
}

function input(senderId: string, command: { name: string } | null = null): GateInput {
  const message: ChatMessage = {
    id: '10',
    channelId: 'tg',
    chatId: `P:${senderId}`,
    receiver: null,
    replyTo: null,
    out: false,
    sender: 'Mem',
    senderId,
    timestamp: 1,
    parts: [{ kind: 'text', text: 'hi' }],
  }
  return {
    envelope: { message, chatName: null, mentioned: false },
    message,
    key: `tg P:${senderId}`,
    chatType: 'private',
    command,
  }
}

const OWNER = user('900', { role: 'owner' })

describe('PermissionGate 判定矩阵', () => {
  it('owner / allow 档直通', async () => {
    const { gate } = makeGate({ users: [OWNER, user('2', { private: 'allow' })] })
    expect(await gate.evaluate(input('900'))).toEqual({ kind: 'pass' })
    expect(await gate.evaluate(input('2'))).toEqual({ kind: 'pass' })
  })

  it('ignore 档：明确反馈后终结（不静默）', async () => {
    const { gate, replies, approvals } = makeGate({ users: [OWNER, user('4', { private: 'ignore' })] })
    expect(await gate.evaluate(input('4'))).toEqual({ kind: 'handled' })
    expect(replies[0]).toContain('没有使用权限')
    expect(approvals).toHaveLength(0)
  })

  it('review 档 + 免审命令 → exempt；ignore 档不豁免（显式拉黑强于免审）', async () => {
    const { gate } = makeGate({ users: [OWNER, user('3')], gated: { help: false } })
    expect(await gate.evaluate(input('3', { name: 'help' }))).toEqual({ kind: 'exempt' })

    const blocked = makeGate({ users: [OWNER, user('4', { private: 'ignore' })], gated: { help: false } })
    expect(await blocked.gate.evaluate(input('4', { name: 'help' }))).toEqual({ kind: 'handled' })
  })

  it('review 档：有 owner 转人工（reason 为 null）；无 owner 反馈提示', async () => {
    const { gate, approvals } = makeGate({ users: [OWNER, user('3')] })
    expect(await gate.evaluate(input('3'))).toEqual({ kind: 'handled' })
    expect(approvals).toEqual([{ envelope: expect.anything() as InboundEnvelope, reason: null }])

    const noOwner = makeGate({ users: [user('3')] })
    expect(await noOwner.gate.evaluate(input('3'))).toEqual({ kind: 'handled' })
    expect(noOwner.replies[0]).toContain('未绑定 owner')
    expect(noOwner.approvals).toHaveLength(0)
  })

  it('auto 通过：有卡片先 settle 再放行；无卡片直接放行', async () => {
    const withCard = makeGate({ users: [OWNER, user('5', { private: 'auto' })] })
    expect(await withCard.gate.evaluate(input('5'))).toEqual({ kind: 'pass' })
    expect(withCard.settled).toEqual([{ pendingId: 7, passed: true }])

    const noCard = makeGate({ users: [OWNER, user('5', { private: 'auto' })], card: false })
    expect(await noCard.gate.evaluate(input('5'))).toEqual({ kind: 'pass' })
    expect(noCard.settled).toHaveLength(0)
  })

  it('auto 拒绝：有卡片走 settle 转人工（绝不双卡片）；无卡片回落 requestApproval 且带原因', async () => {
    const withCard = makeGate({
      users: [OWNER, user('5', { private: 'auto' })],
      verdict: { passed: false, reason: '拿不准' },
    })
    expect(await withCard.gate.evaluate(input('5'))).toEqual({ kind: 'handled' })
    expect(withCard.settled).toEqual([{ pendingId: 7, passed: false }])
    expect(withCard.approvals).toHaveLength(0)

    const noCard = makeGate({
      users: [OWNER, user('5', { private: 'auto' })],
      verdict: { passed: false, reason: '拿不准' },
      card: false,
    })
    expect(await noCard.gate.evaluate(input('5'))).toEqual({ kind: 'handled' })
    expect(noCard.approvals).toEqual([{ envelope: expect.anything() as InboundEnvelope, reason: '拿不准' }])
  })

  it('auto 档无 owner：审核照跑，通过照放行（owner 检查只挡转人工路径）', async () => {
    const { gate, reviews } = makeGate({ users: [user('5', { private: 'auto' })], card: false })
    expect(await gate.evaluate(input('5'))).toEqual({ kind: 'pass' })
    expect(reviews).toHaveLength(1)
  })

  it('未登记发送者默认 review 档', async () => {
    const { gate, approvals } = makeGate({ users: [OWNER] })
    expect(await gate.evaluate(input('999'))).toEqual({ kind: 'handled' })
    expect(approvals).toHaveLength(1)
  })
})
