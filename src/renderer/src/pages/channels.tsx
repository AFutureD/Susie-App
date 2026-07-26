import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { ChannelSettings, ConfigState, TelegramBotChannelSettings } from '../../../shared/config'
import { Button, CheckboxField, ErrorText, Field, TextInput } from '../components/form'
import { OwnerBindModal } from '../components/owner-bind'
import { Page } from '../components/page'
import { configStateAtom } from '../lib/config-atoms'
import { ipc, susie } from '../lib/ipc'
import { channelStatusesAtom } from '../lib/service-atoms'

const STATE_DOT: Record<string, string> = {
  running: 'bg-emerald-500',
  starting: 'bg-amber-500',
  error: 'bg-red-500',
  stopped: 'bg-neutral-400',
}

function maskToken(token: string): string {
  if (token.length <= 8) return '••••••'
  return `${token.slice(0, 4)}••••${token.slice(-4)}`
}

export function ChannelsPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const statuses = useAtomValue(channelStatusesAtom)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  // 新建频道后立即进入 owner 绑定（之后仍可在「用户」页调整）
  const [ownerBindChannel, setOwnerBindChannel] = useState<string | null>(null)

  if (!state) {
    return <Page titleId="page.channels.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  const channels = Object.entries(state.config.channels)
  const statusById = new Map(statuses.map((status) => [status.id, status]))

  const deleteChannel = async (id: string) => {
    if (!window.confirm(intl.formatMessage({ id: 'channels.deleteConfirm' }, { id }))) return
    const result = await ipc.config.deleteChannel({ id, expectedVersion: state.version })
    if (!result.ok) window.alert(result.message)
  }

  const toggleEnabled = async (id: string) => {
    const settings = state.config.channels[id]
    if (settings === undefined) return
    const result = await ipc.config.upsertChannel({
      id,
      settings: { ...settings, enabled: !settings.enabled },
      expectedVersion: state.version,
    })
    if (!result.ok) window.alert(result.message)
  }

  return (
    <Page titleId="page.channels.title">
      <div className="flex flex-col gap-3">
        {channels.length === 0 && (
          <div className="rounded-xl border border-dashed border-line bg-raised/50 p-6 text-sm text-ink-muted">
            {intl.formatMessage({ id: 'page.channels.empty' })}
          </div>
        )}

        {channels.map(([id, settings]) => {
          const status = statusById.get(id)
          return (
            <div key={id} className="rounded-xl border border-line bg-raised p-4">
              <div className="flex items-center gap-3">
                <span
                  className={`size-2.5 shrink-0 rounded-full ${STATE_DOT[status?.state ?? 'stopped']}`}
                  title={status?.state ?? 'stopped'}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{id}</span>
                    <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                      {settings.type}
                    </span>
                    {status?.detail !== null && status?.detail !== undefined && (
                      <span
                        className={`truncate text-xs ${status.state === 'error' ? 'text-red-500' : 'text-ink-muted'}`}
                      >
                        {status.detail}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex gap-4 font-mono text-xs text-ink-muted">
                    <span>token {maskToken(settings.token)}</span>
                  </div>
                </div>
                <Button onClick={() => void toggleEnabled(id)}>
                  {intl.formatMessage({ id: settings.enabled ? 'channels.disable' : 'channels.enable' })}
                </Button>
                <Button onClick={() => setEditing(editing === id ? null : id)}>
                  {intl.formatMessage({ id: 'common.edit' })}
                </Button>
                <Button variant="danger" onClick={() => void deleteChannel(id)}>
                  {intl.formatMessage({ id: 'common.delete' })}
                </Button>
              </div>

              {editing === id && (
                <ChannelForm
                  key={`${id}@${state.version}`}
                  channelId={id}
                  initial={settings}
                  state={state}
                  onDone={() => setEditing(null)}
                />
              )}
            </div>
          )
        })}

        {editing === 'new' ? (
          <div className="rounded-xl border border-line bg-raised p-4">
            <ChannelForm state={state} onDone={() => setEditing(null)} onCreated={setOwnerBindChannel} />
          </div>
        ) : (
          <div>
            <Button variant="primary" onClick={() => setEditing('new')}>
              {intl.formatMessage({ id: 'channels.add' })}
            </Button>
          </div>
        )}
      </div>

      {ownerBindChannel !== null && ownerBindChannel in state.config.channels && (
        <OwnerBindModal state={state} channelId={ownerBindChannel} onClose={() => setOwnerBindChannel(null)} />
      )}
    </Page>
  )
}

function ChannelForm({
  channelId,
  initial,
  state,
  onDone,
  onCreated,
}: {
  channelId?: string
  initial?: TelegramBotChannelSettings
  state: ConfigState
  onDone: () => void
  /** 仅新建成功时回调（进入 owner 绑定） */
  onCreated?: (id: string) => void
}) {
  const intl = useIntl()

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
