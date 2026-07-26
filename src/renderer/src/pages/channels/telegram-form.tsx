import { useState } from 'react'
import { useIntl } from 'react-intl'
import type { ChannelSettings, TelegramBotChannelSettings } from '../../../../shared/config'
import { Button, CheckboxField, ErrorText, Field, TextInput } from '../../components/form'
import { ipc } from '../../lib/ipc'
import type { ChannelFormProps } from './form-types'

function maskToken(token: string): string {
  if (token.length <= 8) return '••••••'
  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}

export function TelegramChannelSummary({ settings }: { settings: ChannelSettings }) {
  return <span>token {maskToken(settings.token)}</span>
}

export function TelegramChannelForm({
  channelId,
  initial: initialSettings,
  state,
  onDone,
  onCreated,
}: ChannelFormProps) {
  const intl = useIntl()
  // 注册表按 settings.type 分发，进入本表单的 initial 必为 telegram_bot
  const initial = initialSettings as TelegramBotChannelSettings | undefined

  const [id, setId] = useState(channelId ?? '')
  const [token, setToken] = useState(initial?.token ?? '')
  const [dropPending, setDropPending] = useState(initial?.drop_pending_updates ?? false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)

    // 频道 ID 留空 → 用 token 问 getMe 拿 bot username
    let finalId = id.trim()
    if (finalId === '') {
      const resolved = await ipc.channels.resolveUsername({ token: token.trim() })
      if (!resolved.ok) {
        setBusy(false)
        setError(intl.formatMessage({ id: 'channels.resolve.failed' }, { detail: resolved.message }))
        return
      }
      finalId = resolved.username
    }
    if (channelId === undefined && finalId in state.config.channels) {
      setBusy(false)
      setError(intl.formatMessage({ id: 'channels.duplicate' }, { id: finalId }))
      return
    }

    // 准入统一由「会话绑定」控制：channel 只剩连接与运行参数
    const settings: ChannelSettings = {
      type: 'telegram_bot',
      token: token.trim(),
      enabled: initial?.enabled ?? true,
      drop_pending_updates: dropPending,
    }
    const result = await ipc.config.upsertChannel({
      id: finalId,
      settings,
      expectedVersion: state.version,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onDone()
    if (channelId === undefined) onCreated?.(finalId)
  }

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={intl.formatMessage({ id: 'channels.field.id' })}
          hint={channelId === undefined ? intl.formatMessage({ id: 'channels.field.id.hint' }) : undefined}
        >
          <TextInput
            value={id}
            onChange={(event) => setId(event.target.value)}
            disabled={channelId !== undefined}
            placeholder="my_bot"
          />
        </Field>
        <Field label={intl.formatMessage({ id: 'channels.field.token' })}>
          <TextInput value={token} onChange={(event) => setToken(event.target.value)} placeholder="123456:bot-token" />
        </Field>
      </div>

      <div className="flex gap-6">
        <CheckboxField
          label={intl.formatMessage({ id: 'channels.field.dropPending' })}
          checked={dropPending}
          onChange={setDropPending}
        />
      </div>
      <ErrorText message={error} />
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || token.trim() === ''} onClick={() => void submit()}>
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        <Button onClick={onDone}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
      </div>
    </div>
  )
}
