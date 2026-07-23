import { useEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'
import { Button, CheckboxField } from '../components/form'
import { Page } from '../components/page'
import { susie } from '../lib/ipc'

type LogFile = 'main' | 'error'

export function LogsPage() {
  const intl = useIntl()
  const [file, setFile] = useState<LogFile>('main')
  const [logPath, setLogPath] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [follow, setFollow] = useState(true)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const refresh = (target: LogFile = file) => {
    void susie.invoke('logs:tail', { lines: 400, file: target }).then((result) => {
      setLogPath(result.path)
      setLines(result.lines)
    })
  }

  useEffect(() => {
    refresh(file)
  }, [file])

  useEffect(() => {
    if (!follow) return
    const timer = setInterval(() => refresh(), 3000)
    return () => clearInterval(timer)
  }, [follow, file])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [lines])

  return (
    <Page titleId="page.logs.title">
      <div className="mb-3 flex items-center gap-3">
        <div className="flex gap-1">
          <Button variant={file === 'main' ? 'primary' : 'ghost'} onClick={() => setFile('main')}>
            {intl.formatMessage({ id: 'logs.file.main' })}
          </Button>
          <Button variant={file === 'error' ? 'primary' : 'ghost'} onClick={() => setFile('error')}>
            {intl.formatMessage({ id: 'logs.file.error' })}
          </Button>
        </div>
        <span className="flex-1 truncate font-mono text-xs text-ink-muted">{logPath}</span>
        <CheckboxField label={intl.formatMessage({ id: 'logs.follow' })} checked={follow} onChange={setFollow} />
        <Button onClick={() => refresh()}>{intl.formatMessage({ id: 'logs.refresh' })}</Button>
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
