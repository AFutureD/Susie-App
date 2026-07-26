import type { DatabaseSync } from 'node:sqlite'
import type { TaskDelivery, TaskRunRecord, TaskRunStatus, TaskTrigger } from '../../shared/messages'
import type { AppDatabase } from '../db/database'

// 定时任务执行历史的持久层（tasks 域拥有）：running → ok/error 全程留痕，供任务页回溯。

/** 每任务保留的执行记录上限（插入时修剪，旧记录静默淘汰） */
const KEEP_PER_TASK = 500

interface TaskRunRow {
  id: number
  task_id: string
  task_name: string
  trigger: string
  status: string
  result: string | null
  error: string | null
  deliveries: string
  started_ts: number
  finished_ts: number | null
}

function rowToRecord(row: TaskRunRow): TaskRunRecord {
  let deliveries: TaskDelivery[] = []
  try {
    deliveries = JSON.parse(row.deliveries) as TaskDelivery[]
  } catch {
    // 列损坏只影响投递明细展示，不阻断历史读取
  }
  return {
    id: row.id,
    taskId: row.task_id,
    taskName: row.task_name,
    trigger: row.trigger as TaskTrigger,
    status: row.status as TaskRunStatus,
    result: row.result,
    error: row.error,
    deliveries,
    startedTs: row.started_ts,
    finishedTs: row.finished_ts,
  }
}

export class TaskRunRepo {
  private readonly db: DatabaseSync

  constructor(database: AppDatabase) {
    this.db = database.db
  }

  /** 建一条执行记录（status = running）并修剪该任务的旧记录 */
  create(input: { taskId: string; taskName: string; trigger: TaskTrigger; startedTs: number }): TaskRunRecord {
    const result = this.db
      .prepare(
        `INSERT INTO task_runs(task_id, task_name, "trigger", status, started_ts)
         VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(input.taskId, input.taskName, input.trigger, input.startedTs)
    this.db
      .prepare(
        `DELETE FROM task_runs WHERE task_id = ? AND id NOT IN
           (SELECT id FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?)`,
      )
      .run(input.taskId, input.taskId, KEEP_PER_TASK)
    return {
      id: Number(result.lastInsertRowid),
      taskId: input.taskId,
      taskName: input.taskName,
      trigger: input.trigger,
      status: 'running',
      result: null,
      error: null,
      deliveries: [],
      startedTs: input.startedTs,
      finishedTs: null,
    }
  }

  /** 落定执行结论（ok/error）；记录不存在返回 null */
  finish(
    id: number,
    outcome: {
      status: Exclude<TaskRunStatus, 'running'>
      result: string | null
      error: string | null
      deliveries: TaskDelivery[]
      finishedTs: number
    },
  ): TaskRunRecord | null {
    this.db
      .prepare('UPDATE task_runs SET status = ?, result = ?, error = ?, deliveries = ?, finished_ts = ? WHERE id = ?')
      .run(outcome.status, outcome.result, outcome.error, JSON.stringify(outcome.deliveries), outcome.finishedTs, id)
    return this.get(id)
  }

  get(id: number): TaskRunRecord | null {
    const row = this.db.prepare('SELECT * FROM task_runs WHERE id = ?').get(id) as unknown as TaskRunRow | undefined
    return row === undefined ? null : rowToRecord(row)
  }

  /** 最近的执行记录（新 → 旧）；taskId 省略时跨全部任务 */
  list(options: { taskId?: string; limit?: number } = {}): TaskRunRecord[] {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const rows = (options.taskId === undefined
      ? this.db.prepare('SELECT * FROM task_runs ORDER BY id DESC LIMIT ?').all(limit)
      : this.db
          .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT ?')
          .all(options.taskId, limit)) as unknown as TaskRunRow[]
    return rows.map(rowToRecord)
  }

  /** 某任务最近一次执行；无记录返回 null */
  latest(taskId: string): TaskRunRecord | null {
    const row = this.db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY id DESC LIMIT 1')
      .get(taskId) as unknown as TaskRunRow | undefined
    return row === undefined ? null : rowToRecord(row)
  }
}
