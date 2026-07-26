import { describe, expect, it } from 'vitest'
import type { ChatMessage, InboundEnvelope } from '../../shared/messages'
import { AppDatabase } from '../db/database'
import { ApprovalRepo } from './approval-repo'

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '1',
    channelId: 'ch',
    chatId: 'P:1',
    receiver: null,
    replyTo: null,
    out: false,
    sender: 'alice',
    senderId: '100',
    timestamp: 1000,
    parts: [{ kind: 'text', text: 'hello world' }],
    ...overrides,
  }
}

const envelope = (text: string): InboundEnvelope => ({
  message: msg({ parts: [{ kind: 'text', text }] }),
  chatName: '客厅',
  mentioned: false,
})

function makeRepo(): ApprovalRepo {
  return new ApprovalRepo(new AppDatabase(':memory:'))
}

describe('ApprovalRepo', () => {
  it('creates, reads back and round-trips the envelope', () => {
    const repo = makeRepo()
    const created = repo.create({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '100',
      sender: 'alice',
      envelope: envelope('please'),
      createdTs: 1234,
    })
    expect(created.status).toBe('pending')

    const loaded = repo.get(created.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.envelope).toEqual(envelope('please'))
    expect(loaded?.cardChatId).toBeNull()
    expect(repo.get(999)).toBeNull()
  })

  it('stores the approval card location', () => {
    const repo = makeRepo()
    const created = repo.create({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '100',
      sender: 'alice',
      envelope: envelope('hi'),
      createdTs: 1,
    })
    repo.setCard(created.id, 'P:900', '42')
    const loaded = repo.get(created.id)
    expect(loaded?.cardChatId).toBe('P:900')
    expect(loaded?.cardMsgId).toBe('42')
  })

  it('claims atomically: only the first transition from pending wins', () => {
    const repo = makeRepo()
    const created = repo.create({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '100',
      sender: 'alice',
      envelope: envelope('hi'),
      createdTs: 1,
    })

    expect(repo.claim(created.id, 'approved', 2000)).toBe(true)
    // 双击/重放：第二次认领失败
    expect(repo.claim(created.id, 'denied', 3000)).toBe(false)

    const loaded = repo.get(created.id)
    expect(loaded?.status).toBe('approved')
    expect(loaded?.decidedTs).toBe(2000)
  })

  it('lists only pending rows, oldest first, scoped by channel', () => {
    const repo = makeRepo()
    const first = repo.create({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '1',
      sender: 'a',
      envelope: envelope('1'),
      createdTs: 1,
    })
    repo.create({ channelId: 'ch', chatId: 'P:2', senderId: '2', sender: 'b', envelope: envelope('2'), createdTs: 2 })
    repo.create({
      channelId: 'other',
      chatId: 'P:3',
      senderId: '3',
      sender: 'c',
      envelope: envelope('3'),
      createdTs: 3,
    })
    repo.claim(first.id, 'denied', 9)

    expect(repo.listPending().map((p) => p.senderId)).toEqual(['2', '3'])
    expect(repo.listPending('ch').map((p) => p.senderId)).toEqual(['2'])
  })

  it('carries the auto-review reason on a fallen-back approval', () => {
    const repo = makeRepo()
    const created = repo.create({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '100',
      sender: 'alice',
      envelope: envelope('zip the repo'),
      createdTs: 1,
      autoReviewReason: '疑似打包外泄',
    })
    expect(created.autoReviewReason).toBe('疑似打包外泄')
    expect(repo.get(created.id)?.autoReviewReason).toBe('疑似打包外泄')
  })
})
