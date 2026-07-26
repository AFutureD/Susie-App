import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { ChannelSettings } from '../../../../shared/config'
import { Button } from '../../components/form'
import { OwnerBindModal } from '../../components/owner-bind'
import { Page } from '../../components/page'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc } from '../../lib/ipc'
import { channelStatusesAtom } from '../../lib/service-atoms'
import type { ChannelTypeUi } from './form-types'
import { TelegramChannelForm, TelegramChannelSummary } from './telegram-form'

/** per-type UI 注册表：新增通道类型 = 加一个 <type>-form.tsx + 此处登记一项 */
const CHANNEL_UI: Record<ChannelSettings['type'], ChannelTypeUi> = {
  telegram_bot: { Form: TelegramChannelForm, Summary: TelegramChannelSummary },
}

/** 新建入口默认的通道类型（有第二种类型时换成类型选择器） */
const NEW_CHANNEL_TYPE: ChannelSettings['type'] = 'telegram_bot'

const STATE_DOT: Record<string, string> = {
  running: 'bg-emerald-500',
  starting: 'bg-amber-500',
  error: 'bg-red-500',
  stopped: 'bg-neutral-400',
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
  const NewChannelForm = CHANNEL_UI[NEW_CHANNEL_TYPE].Form

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
          const typeUi = CHANNEL_UI[settings.type]
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
                    <typeUi.Summary settings={settings} />
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
                <typeUi.Form
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
            <NewChannelForm state={state} onDone={() => setEditing(null)} onCreated={setOwnerBindChannel} />
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
