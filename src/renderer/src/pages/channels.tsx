import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { ChannelSettings, ConfigState, TelegramBotChannelSettings } from '../../../shared/config'
import { CHAT_ALL } from '../../../shared/config'
import { Button, CheckboxField, ErrorText, Field, TextArea, TextInput } from '../components/form'
import { Page } from '../components/page'
import { configStateAtom } from '../lib/config-atoms'
import { susie } from '../lib/ipc'
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

function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export function ChannelsPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const statuses = useAtomValue(channelStatusesAtom)
  const [editing, setEditing] = useState<string | 'new' | null>(null)

  if (!state) {
    return <Page titleId="page.channels.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  const channels = Object.entries(state.config.channels)
  const statusById = new Map(statuses.map((status) => [status.id, status]))

  const deleteChannel = async (id: string) => {
    if (!window.confirm(intl.formatMessage({ id: 'channels.deleteConfirm' }, { id }))) return
    const result = await susie.invoke('config:delete-channel', { id, expectedVersion: state.version })
    if (!result.ok) window.alert(result.message)
  }

  const toggleEnabled = async (id: string) => {
    const settings = state.config.channels[id]
    if (settings === undefined) return
    const result = await susie.invoke('config:upsert-channel', {
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
                    <span>
                      {intl.formatMessage(
                        { id: 'channels.summary.whitelist' },
                        { count: settings.whitelist.length === 0 ? '0' : String(settings.whitelist.length) },
                      )}
                    </span>
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
            <ChannelForm state={state} onDone={() => setEditing(null)} />
          </div>
        ) : (
          <div>
            <Button variant="primary" onClick={() => setEditing('new')}>
              {intl.formatMessage({ id: 'channels.add' })}
            </Button>
          </div>
        )}
      </div>
    </Page>
  )
}

function ChannelForm({
  channelId,
  initial,
  state,
  onDone,
}: {
  channelId?: string
  initial?: TelegramBotChannelSettings
  state: ConfigState
  onDone: () => void
}) {
  const intl = useIntl()
  const starGroup = initial?.groups[CHAT_ALL]

  const [id, setId] = useState(channelId ?? '')
  const [token, setToken] = useState(initial?.token ?? '')
  const [whitelist, setWhitelist] = useState((initial?.whitelist ?? []).join('\n'))
  const [dropPending, setDropPending] = useState(initial?.drop_pending_updates ?? false)
  const [onlyMention, setOnlyMention] = useState(starGroup?.only_mention ?? true)
  const [groupWhitelist, setGroupWhitelist] = useState((starGroup?.whitelist ?? [CHAT_ALL]).join('\n'))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const settings: ChannelSettings = {
      type: 'telegram_bot',
      token: token.trim(),
      enabled: initial?.enabled ?? true,
      whitelist: parseLines(whitelist),
      drop_pending_updates: dropPending,
      groups: {
        ...initial?.groups,
        [CHAT_ALL]: { whitelist: parseLines(groupWhitelist), only_mention: onlyMention },
      },
    }
    const result = await susie.invoke('config:upsert-channel', {
      id: id.trim(),
      settings,
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
        <Field label={intl.formatMessage({ id: 'channels.field.id' })}>
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
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={intl.formatMessage({ id: 'channels.field.whitelist' })}
          hint={intl.formatMessage({ id: 'channels.field.whitelist.hint' })}
        >
          <TextArea rows={3} value={whitelist} onChange={(event) => setWhitelist(event.target.value)} />
        </Field>
        <Field
          label={intl.formatMessage({ id: 'channels.field.groupWhitelist' })}
          hint={intl.formatMessage({ id: 'channels.field.groupWhitelist.hint' })}
        >
          <TextArea rows={3} value={groupWhitelist} onChange={(event) => setGroupWhitelist(event.target.value)} />
        </Field>
      </div>
      <div className="flex gap-6">
        <CheckboxField
          label={intl.formatMessage({ id: 'channels.field.onlyMention' })}
          checked={onlyMention}
          onChange={setOnlyMention}
        />
        <CheckboxField
          label={intl.formatMessage({ id: 'channels.field.dropPending' })}
          checked={dropPending}
          onChange={setDropPending}
        />
      </div>
      <ErrorText message={error} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={busy || id.trim() === '' || token.trim() === ''}
          onClick={() => void submit()}
        >
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        <Button onClick={onDone}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
      </div>
    </div>
  )
}
