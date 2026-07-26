import { describe, expect, it } from 'vitest'
import type { InboundEnvelope, MessagePart } from '../../shared/messages'
import type { PendingApproval } from './approval-repo'
import { buildCardParts } from './approvals'

// 审核卡片文案的逐字节钉死（全状态矩阵）。
// 这些字符串即将迁入 copy/bot-copy.ts + core/approval-card.ts——迁移的验收标准是本文件零 diff。

function makeEnvelope(parts: MessagePart[], chatName: string | null = '客厅'): InboundEnvelope {
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
      parts,
    },
    chatName,
    mentioned: false,
  }
}

function makePending(
  overrides: Partial<PendingApproval> = {},
  parts: MessagePart[] = [{ kind: 'text', text: '求帮忙' }],
  chatName: string | null = '客厅',
): PendingApproval {
  return {
    id: 42,
    channelId: 'tg',
    chatId: 'P:100',
    senderId: '100',
    sender: 'Mem',
    envelope: makeEnvelope(parts, chatName),
    status: 'pending',
    cardChatId: 'P:900',
    cardMsgId: '1',
    autoReviewReason: null,
    createdTs: 1,
    decidedTs: null,
    ...overrides,
  }
}

/** 卡片恒为单段 text part；返回其文本 */
function cardText(pending: PendingApproval, decision?: string): string {
  const parts = buildCardParts(pending, decision)
  expect(parts).toHaveLength(1)
  const part = parts[0]
  if (part === undefined || part.kind !== 'text') throw new Error('card must be a single text part')
  return part.text
}

describe('buildCardParts 状态矩阵', () => {
  it('pending：标题 + 正文', () => {
    expect(cardText(makePending())).toBe('【待审核】Mem 在「客厅」发来消息：\n求帮忙')
  })

  it('pending + 自动审核未通过原因（auto 拒绝转人工）', () => {
    expect(cardText(makePending({ autoReviewReason: '涉及文件外发' }))).toBe(
      '【待审核】Mem 在「客厅」发来消息：\n求帮忙\n\n🤖 自动审核未通过：涉及文件外发',
    )
  })

  it('auto_reviewing：进度行', () => {
    expect(cardText(makePending({ status: 'auto_reviewing' }))).toBe(
      '【自动审核中】Mem 在「客厅」发来消息：\n求帮忙\n\n🤖 自动审核中…',
    )
  })

  it('auto_passed：放行行（无裁决行）', () => {
    expect(cardText(makePending({ status: 'auto_passed' }))).toBe(
      '【已放行】Mem 在「客厅」发来消息：\n求帮忙\n\n✅ 自动审核通过，已放行处理。',
    )
  })

  it('terminated：放行行 + 终止裁决行（有活跃任务）', () => {
    expect(cardText(makePending({ status: 'terminated' }), '⛔ 已终止，进行中的处理已中断')).toBe(
      '【已终止】Mem 在「客厅」发来消息：\n求帮忙\n\n✅ 自动审核通过，已放行处理。\n\n⛔ 已终止，进行中的处理已中断',
    )
  })

  it('terminated：终止裁决行（处理已结束）', () => {
    expect(cardText(makePending({ status: 'terminated' }), '⛔ 已终止（处理已结束，无可中断任务）')).toBe(
      '【已终止】Mem 在「客厅」发来消息：\n求帮忙\n\n✅ 自动审核通过，已放行处理。\n\n⛔ 已终止（处理已结束，无可中断任务）',
    )
  })

  it('approved：裁决行', () => {
    expect(cardText(makePending({ status: 'approved' }), '✅ 已允许')).toBe(
      '【已允许】Mem 在「客厅」发来消息：\n求帮忙\n\n✅ 已允许',
    )
  })

  it('approved：保留自动审核未通过原因（先拒后允）', () => {
    expect(cardText(makePending({ status: 'approved', autoReviewReason: '拿不准' }), '✅ 已允许')).toBe(
      '【已允许】Mem 在「客厅」发来消息：\n求帮忙\n\n🤖 自动审核未通过：拿不准\n\n✅ 已允许',
    )
  })

  it('denied：裁决行', () => {
    expect(cardText(makePending({ status: 'denied' }), '🚫 已拒绝')).toBe(
      '【已拒绝】Mem 在「客厅」发来消息：\n求帮忙\n\n🚫 已拒绝',
    )
  })

  it('failed：绑定失效裁决行', () => {
    expect(cardText(makePending({ status: 'failed' }), '⚠️ 绑定已失效，未执行')).toBe(
      '【未执行】Mem 在「客厅」发来消息：\n求帮忙\n\n⚠️ 绑定已失效，未执行',
    )
  })
})

describe('buildCardParts 正文组装', () => {
  it('附件计数：文本 + 文件', () => {
    expect(
      cardText(
        makePending({}, [
          { kind: 'text', text: '带附件' },
          { kind: 'file', path: '/tmp/a.png' },
          { kind: 'file', path: '/tmp/b.ogg' },
        ]),
      ),
    ).toBe('【待审核】Mem 在「客厅」发来消息：\n带附件\n（含 2 个附件）')
  })

  it('纯附件（无文本）：省略正文行', () => {
    expect(cardText(makePending({}, [{ kind: 'file', path: '/tmp/a.png' }]))).toBe(
      '【待审核】Mem 在「客厅」发来消息：\n（含 1 个附件）',
    )
  })

  it('quote part 不进卡片正文（partsToPlainText 只取 text）', () => {
    expect(
      cardText(
        makePending({}, [
          { kind: 'quote', title: '[tool] ls', body: 'total 0' },
          { kind: 'text', text: '正文' },
        ]),
      ),
    ).toBe('【待审核】Mem 在「客厅」发来消息：\n正文')
  })

  it('超长正文截断到 500 字符 + 省略号', () => {
    const text = 'x'.repeat(520)
    expect(cardText(makePending({}, [{ kind: 'text', text }]))).toBe(
      `【待审核】Mem 在「客厅」发来消息：\n${'x'.repeat(500)}…`,
    )
  })

  it('发送者回退：sender → senderId → 未知用户', () => {
    expect(cardText(makePending({ sender: null }))).toBe('【待审核】100 在「客厅」发来消息：\n求帮忙')
    expect(cardText(makePending({ sender: null, senderId: null }))).toBe(
      '【待审核】未知用户 在「客厅」发来消息：\n求帮忙',
    )
  })

  it('会话名回退：chatName 缺失时用 chatId', () => {
    expect(cardText(makePending({}, [{ kind: 'text', text: '求帮忙' }], null))).toBe(
      '【待审核】Mem 在「P:100」发来消息：\n求帮忙',
    )
  })
})
