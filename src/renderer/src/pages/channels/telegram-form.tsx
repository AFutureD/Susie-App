import { useState } from 'react'
import { useIntl } from 'react-intl'
import type { TelegramBotChannelSettings } from '../../../../shared/config'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ipc } from '../../lib/ipc'
import type { ChannelFormProps } from './form-types'

/** telegram_bot 渠道的行内编辑（新增走统一的 AddBotForm） */
export function TelegramChannelForm({ channelId, initial: initialSettings, state, onDone }: ChannelFormProps) {
  const intl = useIntl()
  // 注册表按 settings.type 分发，进入本表单的 initial 必为 telegram_bot
  const initial = initialSettings as TelegramBotChannelSettings

  const [token, setToken] = useState(initial.token)
  const [dropPending, setDropPending] = useState(initial.drop_pending_updates)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const result = await ipc.config.upsertChannel({
      id: channelId,
      settings: { ...initial, token: token.trim(), drop_pending_updates: dropPending },
      expectedVersion: state.version,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onDone()
  }

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor={`channel-${channelId}-id`}>{intl.formatMessage({ id: 'channels.field.id' })}</FieldLabel>
          <Input id={`channel-${channelId}-id`} value={channelId} disabled />
        </Field>
        <Field>
          <FieldLabel htmlFor={`channel-${channelId}-token`}>
            {intl.formatMessage({ id: 'channels.field.token' })}
          </FieldLabel>
          <Input
            id={`channel-${channelId}-token`}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="123456:bot-token"
          />
        </Field>
      </div>

      <div className="flex gap-6">
        <Field orientation="horizontal">
          <Checkbox
            id={`channel-${channelId}-drop-pending`}
            checked={dropPending}
            onCheckedChange={(value) => setDropPending(value === true)}
          />
          <FieldLabel htmlFor={`channel-${channelId}-drop-pending`}>
            {intl.formatMessage({ id: 'channels.field.dropPending' })}
          </FieldLabel>
        </Field>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button disabled={busy || token.trim() === ''} onClick={() => void submit()}>
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        <Button variant="outline" onClick={onDone}>
          {intl.formatMessage({ id: 'common.cancel' })}
        </Button>
      </div>
    </div>
  )
}
