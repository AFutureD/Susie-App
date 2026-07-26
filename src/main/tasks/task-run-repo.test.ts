import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../db/database'
import { TaskRunRepo } from './task-run-repo'

describe('TaskRunRepo', () => {
  it('running → 落定，投递明细 JSON 往返，列表新 → 旧', () => {
    const repo = new TaskRunRepo(new AppDatabase(':memory:'))
    const first = repo.create({ taskId: 't1', taskName: '晨报', trigger: 'schedule', startedTs: 1 })
    expect(first.status).toBe('running')
    expect(first.deliveries).toEqual([])

    const second = repo.create({ taskId: 't2', taskName: '周报', trigger: 'manual', startedTs: 2 })

    const done = repo.finish(first.id, {
      status: 'ok',
      result: '今天没有新邮件',
      error: null,
      deliveries: [
        { channel: 'tg', chatId: 'P:1', ok: true, message: null },
        { channel: 'tg', chatId: 'G:-2', ok: false, message: '通道未运行' },
      ],
      finishedTs: 10,
    })
    expect(done?.status).toBe('ok')
    expect(done?.finishedTs).toBe(10)
    expect(done?.deliveries).toHaveLength(2)
    expect(done?.deliveries[1]?.message).toBe('通道未运行')

    expect(repo.list().map((record) => record.id)).toEqual([second.id, first.id])
    expect(repo.list({ taskId: 't1' }).map((record) => record.id)).toEqual([first.id])
    expect(repo.latest('t2')?.trigger).toBe('manual')
    expect(repo.latest('ghost')).toBeNull()
    expect(repo.finish(999, { status: 'error', result: null, error: 'x', deliveries: [], finishedTs: 1 })).toBeNull()
  })

  it('每任务只保留最近 500 条（插入时修剪，不殃及别的任务）', () => {
    const db = new AppDatabase(':memory:')
    const repo = new TaskRunRepo(db)
    repo.create({ taskId: 'other', taskName: '别的', trigger: 'schedule', startedTs: 0 })
    for (let index = 0; index < 502; index += 1) {
      repo.create({ taskId: 't1', taskName: '晨报', trigger: 'schedule', startedTs: index })
    }
    const count = db.db.prepare('SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ?').get('t1') as unknown as {
      n: number
    }
    expect(Number(count.n)).toBe(500)
    // 淘汰的是最旧的两条
    expect(repo.list({ taskId: 't1', limit: 200 }).at(0)?.startedTs).toBe(501)
    expect(repo.latest('other')).not.toBeNull()
  })
})
