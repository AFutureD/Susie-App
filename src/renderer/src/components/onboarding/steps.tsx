import { useState } from 'react'
import { useIntl } from 'react-intl'
import type { ConfigState } from '../../../../shared/config'
import { ipc } from '../../lib/ipc'
import { Button, ErrorText, Field, TextInput } from '../form'
import { OwnerBindPanel } from '../owner-bind'

// 向导第 1/2 步与完成页（第 3 步会话绑定在 binding-step.tsx）。

export function ChannelStep({
  state,
  onCreated,
}: {
  state: ConfigState
  onCreated: (channelId: string, username: string) => void
}) {
  const intl = useIntl()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const trimmed = token.trim()
    // 用 token 问 getMe：既校验 token，又拿 username 作频道 ID 与深链
    const resolved = await ipc.channels.resolveUsername({ token: trimmed })
    if (!resolved.ok) {
      setBusy(false)
      setError(intl.formatMessage({ id: 'channels.resolve.failed' }, { detail: resolved.message }))
      return
    }
    const result = await ipc.config.upsertChannel({
      id: resolved.username,
      settings: { type: 'telegram_bot', token: trimmed, enabled: true, drop_pending_updates: false },
      expectedVersion: state.version,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onCreated(resolved.username, resolved.username)
  }

  return (
    <section className="rounded-xl border border-line bg-raised p-5">
      <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'onboarding.step.channel' })}</h2>
      <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 text-sm leading-6 text-ink-muted">
        <li>{intl.formatMessage({ id: 'onboarding.channel.guide.step1' })}</li>
        <li>{intl.formatMessage({ id: 'onboarding.channel.guide.step2' })}</li>
      </ol>
      <div className="mt-3">
        <Button onClick={() => void ipc.app.openExternal({ url: 'https://t.me/BotFather' })}>
          {intl.formatMessage({ id: 'onboarding.channel.guide.open' })}
        </Button>
      </div>

      <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4">
        <Field label={intl.formatMessage({ id: 'channels.field.token' })}>
          <TextInput
            value={token}
            autoFocus
            placeholder="123456:bot-token"
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <ErrorText message={error} />
        <div>
          <Button variant="primary" disabled={busy || token.trim() === ''} onClick={() => void submit()}>
            {intl.formatMessage({ id: busy ? 'onboarding.channel.connecting' : 'onboarding.channel.submit' })}
          </Button>
        </div>
      </div>
    </section>
  )
}

// ---------- 第 2 步：绑定 owner ----------

export function OwnerStep({
  state,
  channelId,
  botUsername,
  linkError,
  onBound,
}: {
  state: ConfigState
  channelId: string
  botUsername: string | null
  linkError: string | null
  onBound: () => void
}) {
  const intl = useIntl()
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'onboarding.step.owner' })}</h2>
        <p className="mt-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'ownerBind.subtitle' })}</p>
      </div>
      <div className="rounded-xl border border-line bg-raised p-4">
        <OwnerBindPanel
          state={state}
          channelId={channelId}
          botUsername={botUsername}
          linkError={linkError}
          onBound={onBound}
        />
      </div>
    </section>
  )
}

// ---------- 第 3 步：会话绑定 ----------

export function DoneStep({ onClose }: { onClose: () => void }) {
  const intl = useIntl()
  return (
    <section className="rounded-xl border border-line bg-raised p-6 text-center">
      <div className="text-3xl">🎉</div>
      <h2 className="mt-2 text-base font-semibold">{intl.formatMessage({ id: 'onboarding.done.title' })}</h2>
      <p className="mt-2 text-sm leading-6 text-ink-muted">{intl.formatMessage({ id: 'onboarding.done.desc' })}</p>
      <div className="mt-5">
        <Button variant="primary" onClick={onClose}>
          {intl.formatMessage({ id: 'onboarding.done.cta' })}
        </Button>
      </div>
    </section>
  )
}
