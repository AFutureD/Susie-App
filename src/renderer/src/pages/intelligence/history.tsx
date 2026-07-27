import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { Link } from 'react-router'
import type { AutoReviewRecord, AutoReviewStatus } from '../../../../shared/messages'
import { Page } from '../../components/page'
import { ipc, onIpcEvent } from '../../lib/ipc'

// 自动审核历史子页（/intelligence/history）：审核记录实时刷新，入口在智能页「自动审核」卡片标题旁。

/** 自动审核记录状态 → 徽章样式 */
const STATUS_BADGE: Record<AutoReviewStatus, string> = {
  running: 'bg-accent/10 text-accent',
  passed: 'bg-emerald-500/10 text-emerald-600',
  rejected: 'bg-amber-500/10 text-amber-600',
  error: 'bg-red-500/10 text-red-500',
}

export function AutoReviewHistoryPage() {
  const intl = useIntl()
  const [records, setRecords] = useState<AutoReviewRecord[] | null>(null)

  useEffect(() => {
    let alive = true
    void ipc.autoReview.list({ limit: 100 }).then((list) => {
      if (alive) setRecords(list)
    })
    // 新记录/状态更新按 id 合并（进行中 → 结论）
    const off = onIpcEvent('autoReview.record', (record) => {
      setRecords((prev) => {
        const base = prev ?? []
        const rest = base.filter((item) => item.id !== record.id)
        return [record, ...rest].toSorted((a, b) => b.id - a.id)
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <Page titleId="page.intelligenceHistory.title">
      <div className="mb-4 flex items-center">
        <Link
          to="/intelligence"
          className="shrink-0 text-xs whitespace-nowrap text-ink-muted transition-colors hover:text-ink"
        >
          {intl.formatMessage({ id: 'intelligence.history.back' })}
        </Link>
      </div>

      <section className="rounded-xl border border-line bg-raised p-5">
        <p className="text-xs leading-5 text-ink-muted">{intl.formatMessage({ id: 'intelligence.history.hint' })}</p>

        {records !== null && records.length === 0 && (
          <p className="mt-3 text-sm text-ink-muted">{intl.formatMessage({ id: 'intelligence.history.empty' })}</p>
        )}

        {records !== null && records.length > 0 && (
          <div className="mt-3 divide-y divide-line/60">
            {records.map((record) => (
              <AutoReviewRow key={record.id} record={record} />
            ))}
          </div>
        )}
      </section>
    </Page>
  )
}

function AutoReviewRow({ record }: { record: AutoReviewRecord }) {
  const intl = useIntl()
  const when = new Date(record.decidedTs ?? record.createdTs).toLocaleString()

  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_BADGE[record.status]}`}>
        {intl.formatMessage({ id: `intelligence.history.status.${record.status}` })}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="truncate">{record.sender ?? record.senderId ?? '未知用户'}</span>
          <span className="font-mono">{record.chatId}</span>
          <span className="shrink-0">{when}</span>
        </div>
        <p className="mt-0.5 truncate text-sm">{record.text}</p>
        {record.reason !== null && record.status !== 'running' && (
          <p className="mt-0.5 text-xs text-ink-muted/80">→ {record.reason}</p>
        )}
      </div>
    </div>
  )
}
