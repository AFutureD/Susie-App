import { useEffect, useState } from 'react'
import { FormattedMessage, useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { AppInfo } from '../../../shared/ipc'
import { susie } from '../lib/ipc'
import { updateStateAtom } from '../lib/update-atoms'
import { Button } from './form'

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 自动更新状态 + 手动检查/安装入口（状态由主进程 update:state 推送） */
function UpdateSection() {
  const intl = useIntl()
  const update = useAtomValue(updateStateAtom)
  const [busy, setBusy] = useState(false)

  const check = async () => {
    setBusy(true)
    const result = await susie.invoke('update:check')
    setBusy(false)
    if (!result.ok) window.alert(result.message)
  }

  const install = async () => {
    const result = await susie.invoke('update:install')
    if (!result.ok) window.alert(result.message)
  }

  const statusText = (() => {
    switch (update.status) {
      case 'idle':
        return intl.formatMessage({ id: 'update.idle' })
      case 'checking':
        return intl.formatMessage({ id: 'update.checking' })
      case 'available':
        return intl.formatMessage({ id: 'update.available' }, { version: update.version })
      case 'not-available':
        return intl.formatMessage({ id: 'update.upToDate' })
      case 'downloading':
        return intl.formatMessage(
          { id: 'update.downloading' },
          {
            version: update.version,
            percent: update.percent.toFixed(0),
            transferred: formatMegabytes(update.transferred),
            total: formatMegabytes(update.total),
          },
        )
      case 'ready':
        return intl.formatMessage({ id: 'update.ready' }, { version: update.version })
      case 'error':
        return intl.formatMessage({ id: 'update.error' }, { message: update.message })
    }
  })()

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex items-center justify-between gap-4">
        <p className={`text-xs leading-5 ${update.status === 'error' ? 'text-red-500' : 'text-ink-muted'}`}>
          {statusText}
        </p>
        {update.status === 'ready' ? (
          <Button variant="primary" onClick={() => void install()}>
            <FormattedMessage id="update.install" />
          </Button>
        ) : (
          <Button
            disabled={busy || update.status === 'checking' || update.status === 'downloading'}
            onClick={() => void check()}
          >
            <FormattedMessage id="update.check" />
          </Button>
        )}
      </div>
      {update.status === 'downloading' && (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${update.percent}%` }} />
        </div>
      )}
    </div>
  )
}

export function AppInfoCard() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    susie
      .invoke('app:get-info')
      .then(setInfo)
      .catch((e: unknown) => setError(String(e)))
  }, [])

  if (error) {
    return <div className="rounded-xl border border-line bg-raised p-4 text-sm text-red-500">{error}</div>
  }
  if (!info) return null

  const rows: [string, string][] = [
    ['appinfo.app', `${info.name} ${info.version}`],
    ['appinfo.electron', info.electron],
    ['appinfo.chrome', info.chrome],
    ['appinfo.node', info.node],
    ['appinfo.platform', info.platform],
    ['appinfo.mcp', info.mcpUrl ?? '(未启动)'],
  ]

  return (
    <div className="mt-6 rounded-xl border border-line bg-raised p-5">
      <h2 className="mb-3 text-sm font-medium text-ink-muted">
        <FormattedMessage id="appinfo.title" />
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        {rows.map(([id, value]) => (
          <div key={id} className="contents">
            <dt className="text-ink-muted">
              <FormattedMessage id={id} />
            </dt>
            <dd className="font-mono text-xs leading-5">{value}</dd>
          </div>
        ))}
        <div className="contents">
          <dt className="text-ink-muted">
            <FormattedMessage id="appinfo.headless" />
          </dt>
          <dd className="font-mono text-xs leading-5">
            <FormattedMessage id={info.headless ? 'common.yes' : 'common.no'} />
          </dd>
        </div>
      </dl>
      <UpdateSection />
    </div>
  )
}
