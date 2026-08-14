import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { AppInfoCard } from '../components/app-info'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { Page } from '../components/page'
import { configStateAtom } from '../lib/config-atoms'
import { ipc } from '../lib/ipc'
import { toast } from '@/components/ui/toast'

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
      toast.add({ title: result.message, type: 'error' })
    }
  }

  if (enabled === null) return null
  return (
    <Card className="mb-6">
      <CardContent>
        <Field orientation="horizontal">
          <Checkbox
            id="settings-login-item"
            checked={enabled}
            onCheckedChange={(value) => void toggle(value === true)}
          />
          <div>
            <FieldLabel htmlFor="settings-login-item">{intl.formatMessage({ id: 'settings.loginItem' })}</FieldLabel>
            <FieldDescription>{intl.formatMessage({ id: 'settings.loginItem.hint' })}</FieldDescription>
          </div>
        </Field>
      </CardContent>
    </Card>
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
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{state.lastError}</AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>{intl.formatMessage({ id: 'settings.raw.title' })}</CardTitle>
          <div className="flex gap-2">
            <Button variant="outline" onClick={loadRaw}>
              {intl.formatMessage({ id: 'settings.raw.reload' })}
            </Button>
            <Button disabled={busy || raw === null} onClick={() => void save()}>
              {intl.formatMessage({ id: 'settings.raw.save' })}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {outdated && (
            <Alert className="mb-2">
              <AlertDescription>{intl.formatMessage({ id: 'settings.raw.conflictHint' })}</AlertDescription>
            </Alert>
          )}
          <Textarea
            id="settings-raw-config"
            rows={18}
            spellCheck={false}
            value={raw?.text ?? ''}
            onChange={(event) => setRaw(raw === null ? null : { ...raw, text: event.target.value })}
          />
          {error && (
            <Alert variant="destructive" className="mt-2">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <AppInfoCard />
    </Page>
  )
}
