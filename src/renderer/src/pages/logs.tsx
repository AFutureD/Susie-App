import { useEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldLabel } from '@/components/ui/field'
import { Page } from '../components/page'
import { ipc } from '../lib/ipc'

type LogFile = 'main' | 'error'

export function LogsPage() {
  const intl = useIntl()
  const [file, setFile] = useState<LogFile>('main')
  const [logPath, setLogPath] = useState('')
  const [lines, setLines] = useState<string[]>([])
  const [follow, setFollow] = useState(true)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const refresh = (target: LogFile = file) => {
    void ipc.logs.tail({ lines: 400, file: target }).then((result) => {
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
          <Button variant={file === 'main' ? 'default' : 'ghost'} onClick={() => setFile('main')}>
            {intl.formatMessage({ id: 'logs.file.main' })}
          </Button>
          <Button variant={file === 'error' ? 'default' : 'ghost'} onClick={() => setFile('error')}>
            {intl.formatMessage({ id: 'logs.file.error' })}
          </Button>
        </div>
        <span className="flex-1 truncate font-mono text-xs text-ink-muted">{logPath}</span>
        <Field orientation="horizontal" className="w-auto">
          <Checkbox id="logs-follow" checked={follow} onCheckedChange={(value) => setFollow(value === true)} />
          <FieldLabel htmlFor="logs-follow">{intl.formatMessage({ id: 'logs.follow' })}</FieldLabel>
        </Field>
        <Button variant="outline" onClick={() => refresh()}>
          {intl.formatMessage({ id: 'logs.refresh' })}
        </Button>
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
