import { useEffect, useState } from 'react'
import { FormattedMessage } from 'react-intl'
import type { AppInfo } from '../../../shared/ipc'
import { susie } from '../lib/ipc'

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
    </div>
  )
}
