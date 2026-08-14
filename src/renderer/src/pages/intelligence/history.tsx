import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { Link } from 'react-router'
import type { AutoReviewRecord, AutoReviewStatus } from '../../../../shared/messages'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Page } from '../../components/page'
import { ipc, onIpcEvent } from '../../lib/ipc'

// 自动审核历史子页（/intelligence/history）：审核记录实时刷新，入口在智能页「自动审核」卡片标题旁。

/** 自动审核记录状态 → 徽章样式 */
const STATUS_BADGE: Record<AutoReviewStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  running: 'default',
  passed: 'secondary',
  rejected: 'outline',
  error: 'destructive',
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

      <Card>
        <CardContent>
          <p className="text-xs leading-5 text-ink-muted">{intl.formatMessage({ id: 'intelligence.history.hint' })}</p>

          {records !== null && records.length === 0 && (
            <Empty>
              <EmptyDescription>{intl.formatMessage({ id: 'intelligence.history.empty' })}</EmptyDescription>
            </Empty>
          )}

          {records !== null && records.length > 0 && (
            <div className="mt-3 divide-y divide-line/60">
              {records.map((record) => (
                <AutoReviewRow key={record.id} record={record} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </Page>
  )
}

function AutoReviewRow({ record }: { record: AutoReviewRecord }) {
  const intl = useIntl()
  const when = new Date(record.decidedTs ?? record.createdTs).toLocaleString()

  return (
    <div className="flex items-start gap-3 py-2.5">
      <Badge variant={STATUS_BADGE[record.status]} className="mt-0.5 shrink-0">
        {intl.formatMessage({ id: `intelligence.history.status.${record.status}` })}
      </Badge>
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
