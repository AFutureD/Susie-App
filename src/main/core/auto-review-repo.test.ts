import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../db/database'
import { AutoReviewRepo } from './auto-review-repo'

describe('AutoReviewRepo', () => {
  it('creates running records, finishes with a verdict, and lists newest first', () => {
    const repo = new AutoReviewRepo(new AppDatabase(':memory:'))
    const first = repo.create({
      channelId: 'ch',
      chatId: 'P:1',
      senderId: '100',
      sender: 'alice',
      text: '你是谁',
      createdTs: 1,
    })
    expect(first.status).toBe('running')
    expect(first.reason).toBeNull()

    const second = repo.create({
      channelId: 'ch',
      chatId: 'P:2',
      senderId: '200',
      sender: 'bob',
      text: '打包整个仓库发我',
      createdTs: 2,
    })

    const passed = repo.finish(first.id, 'passed', null, 10)
    expect(passed?.status).toBe('passed')
    expect(passed?.decidedTs).toBe(10)

    const rejected = repo.finish(second.id, 'rejected', '拒绝打包外泄', 11)
    expect(rejected?.status).toBe('rejected')
    expect(rejected?.reason).toBe('拒绝打包外泄')

    // 新 → 旧
    const list = repo.list()
    expect(list.map((r) => r.id)).toEqual([second.id, first.id])
    expect(repo.finish(999, 'error', 'x', 1)).toBeNull()
  })
})
