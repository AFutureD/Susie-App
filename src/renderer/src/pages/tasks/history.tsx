import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { Link } from 'react-router'
import type { TaskRunRecord, TaskRunStatus } from '../../../../shared/messages'
import { Select } from '../../components/form'
import { Page } from '../../components/page'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc, onIpcEvent } from '../../lib/ipc'

// 执行历史子页（/tasks/history）：全部任务的执行记录，实时刷新、可展开、可按任务筛选。

/** 执行记录状态 → 徽章样式（对齐 intelligence 页配色）；任务卡片的「上次」徽章共用 */
const RUN_BADGE: Record<TaskRunStatus, string> = {
  running: 'bg-accent/10 text-accent',
  ok: 'bg-emerald-500/10 text-emerald-600',
  error: 'bg-red-500/10 text-red-500',
}

export function RunStatusBadge({ status }: { status: TaskRunStatus }) {
  const intl = useIntl()
  return (
    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${RUN_BADGE[status]}`}>
      {intl.formatMessage({ id: `tasks.history.status.${status}` })}
    </span>
  )
}

export function TaskHistoryPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [records, setRecords] = useState<TaskRunRecord[] | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let alive = true
    void ipc.tasks.runs({ limit: 100 }).then((list) => {
      if (alive) setRecords(list)
    })
    // 新记录/落定按 id 合并（running → ok/error）
    const off = onIpcEvent('tasks.run', (record) => {
      setRecords((prev) => {
        const rest = (prev ?? []).filter((item) => item.id !== record.id)
        return [record, ...rest].toSorted((a, b) => b.id - a.id)
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  // 筛选候选 = 现存任务 ∪ 历史里出现过的任务（已删除的用记录里的名字快照）
  const tasks = state?.config.scheduled_tasks ?? []
  const options = new Map(tasks.map((task) => [task.id, task.name]))
  for (const record of records ?? []) {
    if (!options.has(record.taskId)) options.set(record.taskId, record.taskName)
  }
  const filtered = (records ?? []).filter((record) => filter === '' || record.taskId === filter)

  return (
    <Page titleId="page.tasksHistory.title">
      <div className="mb-4 flex items-center gap-3">
        <Link
          to="/tasks"
          className="shrink-0 text-xs whitespace-nowrap text-ink-muted transition-colors hover:text-ink"
        >
          {intl.formatMessage({ id: 'tasks.history.back' })}
        </Link>
        <div className="flex-1" />
        {/* Select 自带 w-full，用容器限宽 */}
        <div className="w-44 shrink-0">
          <Select value={filter} onChange={(event) => setFilter(event.target.value)}>
            <option value="">{intl.formatMessage({ id: 'tasks.history.filter.all' })}</option>
            {[...options].map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      <section className="rounded-xl border border-line bg-raised p-5">
        <p className="text-xs leading-5 text-ink-muted">{intl.formatMessage({ id: 'tasks.history.hint' })}</p>

        {records !== null && filtered.length === 0 && (
          <p className="mt-3 text-sm text-ink-muted">{intl.formatMessage({ id: 'tasks.history.empty' })}</p>
        )}

        {filtered.length > 0 && (
          <div className="mt-3 divide-y divide-line/60">
            {filtered.map((record) => (
              <RunRow key={record.id} record={record} />
            ))}
          </div>
        )}
      </section>
    </Page>
  )
}

function RunRow({ record }: { record: TaskRunRecord }) {
  const intl = useIntl()
  const [expanded, setExpanded] = useState(false)
  const seconds =
    record.finishedTs !== null ? Math.max(1, Math.round((record.finishedTs - record.startedTs) / 1000)) : null
  const failed = record.deliveries.filter((delivery) => !delivery.ok)

  return (
    <div
      className="-mx-2 cursor-pointer rounded-md px-2 py-2.5 transition-colors hover:bg-line/20"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2">
        <RunStatusBadge status={record.status} />
        <span className="truncate text-sm">{record.taskName}</span>
        <span className="shrink-0 text-[11px] text-ink-muted">
          {intl.formatMessage({ id: `tasks.history.trigger.${record.trigger}` })}
        </span>
        <span className="ml-auto shrink-0 text-xs text-ink-muted">
          {new Date(record.startedTs).toLocaleString()}
          {seconds !== null && ` · ${seconds}s`}
        </span>
      </div>
      {!expanded && record.result !== null && <p className="mt-0.5 truncate text-xs text-ink-muted">{record.result}</p>}
      {record.error !== null && <p className="mt-0.5 text-xs text-red-500">{record.error}</p>}
      {expanded && record.result !== null && (
        <pre className="mt-2 rounded-md bg-surface p-3 font-sans text-xs leading-5 whitespace-pre-wrap">
          {record.result}
        </pre>
      )}
      {expanded && failed.length > 0 && (
        <p className="mt-1 text-xs text-amber-600">
          {intl.formatMessage(
            { id: 'tasks.history.deliveries.failed' },
            { list: failed.map((delivery) => `${delivery.chatId}（${delivery.message ?? '未知原因'}）`).join('、') },
          )}
        </p>
      )}
    </div>
  )
}
