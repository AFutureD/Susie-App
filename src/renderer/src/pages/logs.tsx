import { useEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'
import { Button, CheckboxField } from '../components/form'
import { Page } from '../components/page'
import { susie } from '../lib/ipc'

export function LogsPage() {
  const intl = useIntl()
  const [logPath, setLogPath] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [follow, setFollow] = useState(true)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const refresh = () => {
    void susie.invoke('logs:tail', { lines: 400 }).then((result) => {
      setLogPath(result.path)
      setLines(result.lines)
    })
  }

  useEffect(() => {
    refresh()
  }, [])

  useEffect(() => {
    if (!follow) return
    const timer = setInterval(refresh, 3000)
    return () => clearInterval(timer)
  }, [follow])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lines])

  return (
    <Page titleId="page.logs.title">
      <div className="mb-3 flex items-center gap-3">
        <span className="flex-1 truncate font-mono text-xs text-ink-muted">{logPath}</span>
        <CheckboxField label={intl.formatMessage({ id: 'logs.follow' })} checked={follow} onChange={setFollow} />
        <Button onClick={refresh}>{intl.formatMessage({ id: 'logs.refresh' })}</Button>
      </div>
      <div className="h-[calc(100vh-220px)] overflow-y-auto rounded-xl border border-line bg-raised p-4">
        <pre className="font-mono text-[11px] leading-4.5 whitespace-pre-wrap text-ink-muted select-text">
          {lines.join('\n')}
        </pre>
        <div ref={bottomRef} />
      </div>
    </Page>
  )
}
