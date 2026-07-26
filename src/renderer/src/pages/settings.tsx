import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { AppInfoCard } from '../components/app-info'
import { Button, CheckboxField, ErrorText, TextArea } from '../components/form'
import { Page } from '../components/page'
import { configStateAtom } from '../lib/config-atoms'
import { ipc } from '../lib/ipc'

function LoginItemToggle() {
  const intl = useIntl()
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    void ipc.app.getInfo().then((info) => setEnabled(info.loginItemEnabled))
  }, [])

  const toggle = async (value: boolean) => {
    setEnabled(value)
    const result = await ipc.app.setLoginItem({ enabled: value })
    if (!result.ok) {
      setEnabled(!value)
      window.alert(result.message)
    }
  }

  if (enabled === null) return null
  return (
    <div className="mb-6 rounded-xl border border-line bg-raised p-5">
      <CheckboxField
        label={intl.formatMessage({ id: 'settings.loginItem' })}
        checked={enabled}
        onChange={(value) => void toggle(value)}
      />
      <p className="mt-1.5 text-xs text-ink-muted">{intl.formatMessage({ id: 'settings.loginItem.hint' })}</p>
    </div>
  )
}

export function SettingsPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [raw, setRaw] = useState<{ text: string; version: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const loadRaw = () => {
    void ipc.config.getRaw().then((result) => {
      setRaw(result)
      setError(null)
    })
  }

  useEffect(loadRaw, [])

  const save = async () => {
    if (!raw) return
    setBusy(true)
    setError(null)
    const result = await ipc.config.saveRaw({ text: raw.text, expectedVersion: raw.version })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    loadRaw()
  }

  const outdated = raw !== null && state !== null && raw.version !== state.version

  return (
    <Page titleId="page.settings.title">
      <LoginItemToggle />
      {state && (
        <div className="mb-6 rounded-xl border border-line bg-raised p-5 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
            <dt className="text-ink-muted">{intl.formatMessage({ id: 'settings.configPath' })}</dt>
            <dd className="font-mono text-xs leading-5">{state.configPath}</dd>
            <dt className="text-ink-muted">{intl.formatMessage({ id: 'settings.version' })}</dt>
            <dd className="font-mono text-xs leading-5">v{state.version}</dd>
          </dl>
          {state.lastError && (
            <div className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-500">
              {state.lastError}
            </div>
          )}
        </div>
      )}

      <section className="rounded-xl border border-line bg-raised p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink-muted">{intl.formatMessage({ id: 'settings.raw.title' })}</h2>
          <div className="flex gap-2">
            <Button onClick={loadRaw}>{intl.formatMessage({ id: 'settings.raw.reload' })}</Button>
            <Button variant="primary" disabled={busy || raw === null} onClick={() => void save()}>
              {intl.formatMessage({ id: 'settings.raw.save' })}
            </Button>
          </div>
        </div>
        {outdated && (
          <p className="mb-2 rounded-md bg-accent/10 px-3 py-2 text-xs text-accent">
            {intl.formatMessage({ id: 'settings.raw.conflictHint' })}
          </p>
        )}
        <TextArea
          rows={18}
          spellCheck={false}
          value={raw?.text ?? ''}
          onChange={(event) => setRaw(raw === null ? null : { ...raw, text: event.target.value })}
        />
        <ErrorText message={error} />
      </section>

      <AppInfoCard />
    </Page>
  )
}
