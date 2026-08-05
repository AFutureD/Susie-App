import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { expandBindings } from '../../../../shared/bindings'
import type { ChannelSettings, ConfigState } from '../../../../shared/config'
import type { BotIdentity, ChannelStatus } from '../../../../shared/messages'
import { ChannelDefaultBindingModal } from '../../components/channel-default-binding'
import { Button } from '../../components/form'
import { OwnerBindModal } from '../../components/owner-bind'
import { Page } from '../../components/page'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc } from '../../lib/ipc'
import { channelStatusesAtom, managerStatusesAtom } from '../../lib/service-atoms'
import { useBotIdentityMap } from '../../lib/ipc-query'
import { useConfigMutation } from '../../lib/ipc-mutation'
import { AddBotForm } from './add-bot-form'
import { AddManagedBotModal } from './add-managed-bot-modal'
import { BotUsername } from './bot-username'
import type { ChannelTypeUi } from './form-types'
import { ManagerBotForm } from './manager-form'
import { buildChannelList } from './model'
import { TelegramChannelForm } from './telegram-form'

/** per-type 行内编辑注册表：新增通道类型 = 加一个 <type>-form.tsx + 此处登记一项 */
const CHANNEL_UI: Record<ChannelSettings['type'], ChannelTypeUi> = {
  telegram_bot: { Form: TelegramChannelForm },
}

const STATE_DOT: Record<string, string> = {
  running: 'bg-emerald-500',
  starting: 'bg-amber-500',
  error: 'bg-red-500',
  stopped: 'bg-neutral-400',
}

function StatusDot({ status }: { status: ChannelStatus | undefined }) {
  return (
    <span
      className={`size-2.5 shrink-0 rounded-full ${STATE_DOT[status?.state ?? 'stopped']}`}
      title={status?.state ?? 'stopped'}
    />
  )
}

function StatusDetail({ status }: { status: ChannelStatus | undefined }) {
  if (status?.detail === null || status?.detail === undefined) return null
  return (
    <span className={`truncate text-xs ${status.state === 'error' ? 'text-red-500' : 'text-ink-muted'}`}>
      {status.detail}
    </span>
  )
}

/**
 * 渠道标题块：显示名 + 类型徽标 + 状态详情，副行 @username。
 * 显示名与 username 相同（bot 未单独设置显示名）时只渲染一次——@username 直接顶替标题。
 */
function ChannelIdentity({
  id,
  identity,
  badge,
  status,
}: {
  id: string
  identity: BotIdentity | undefined
  badge: string | null
  status: ChannelStatus | undefined
}) {
  const title = identity?.name ?? id
  const username = identity?.username ?? null
  const duplicate = username !== null && (title === username || title === `@${username}`)
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        {duplicate ? (
          <BotUsername username={username} variant="title" />
        ) : (
          <span className="truncate text-sm font-semibold">{title}</span>
        )}
        {badge !== null && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
            {badge}
          </span>
        )}
        <StatusDetail status={status} />
      </div>
      {!duplicate && username !== null && (
        <div className="mt-1 flex">
          <BotUsername username={username} />
        </div>
      )}
    </div>
  )
}

/**
 * 单个渠道行。card = 顶层独立卡片；row = manager 卡片内的成员行
 * （hairline 分隔的扁平行——避免卡片套卡片）。
 */
function ChannelRow({
  id,
  settings,
  identity,
  status,
  state,
  editing,
  setEditing,
  variant = 'card',
}: {
  id: string
  settings: ChannelSettings
  identity: BotIdentity | undefined
  status: ChannelStatus | undefined
  state: ConfigState
  editing: string | null
  setEditing: (value: string | null) => void
  variant?: 'card' | 'row'
}) {
  const intl = useIntl()
  const mutation = useConfigMutation()
  const typeUi = CHANNEL_UI[settings.type]

  const deleteChannel = async () => {
    if (!window.confirm(intl.formatMessage({ id: 'channels.deleteConfirm' }, { id }))) return
    await mutation.run((expectedVersion) => ipc.config.deleteChannel({ id, expectedVersion }))
  }

  const toggleEnabled = async () => {
    await mutation.run((expectedVersion) =>
      ipc.config.upsertChannel({ id, settings: { ...settings, enabled: !settings.enabled }, expectedVersion }),
    )
  }

  return (
    <div className={variant === 'card' ? 'rounded-xl border border-line bg-raised p-4' : 'py-3'}>
      <div className="flex items-center gap-3">
        <StatusDot status={status} />
        <ChannelIdentity
          id={id}
          identity={identity}
          badge={variant === 'card' ? settings.type : null}
          status={status}
        />
        <Button onClick={() => void toggleEnabled()}>
          {intl.formatMessage({ id: settings.enabled ? 'channels.disable' : 'channels.enable' })}
        </Button>
        <Button onClick={() => setEditing(editing === id ? null : id)}>
          {intl.formatMessage({ id: 'common.edit' })}
        </Button>
        <Button variant="danger" onClick={() => void deleteChannel()}>
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
}

export function ChannelsPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const statuses = useAtomValue(channelStatusesAtom)
  const managerStatuses = useAtomValue(managerStatusesAtom)
  const identityMap = useBotIdentityMap()
  const mutation = useConfigMutation()
  const [editing, setEditing] = useState<string | null>(null)
  const [editingManager, setEditingManager] = useState<string | null>(null)
  /** 统一新增入口（token → getMe 自动识别普通渠道 / manager） */
  const [adding, setAdding] = useState(false)
  const [addManagedFor, setAddManagedFor] = useState<string | null>(null)
  // 新增后的弹窗流：直连渠道/manager 先 owner 绑定，普通渠道随后必绑默认助手；
  // 托管 Bot owner 自动继承 manager，直接进助手绑定
  const [postAdd, setPostAdd] = useState<{ channelId: string; stage: 'owner' | 'assistant' } | null>(null)

  if (!state) {
    return <Page titleId="page.channels.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  const model = buildChannelList(state.config.channels, state.config.manager_bots)
  const managers = Object.entries(state.config.manager_bots)
  const statusById = new Map(statuses.map((status) => [status.id, status]))
  const managerStatusById = new Map(managerStatuses.map((status) => [status.id, status]))

  const deleteManager = async (id: string) => {
    if (!window.confirm(intl.formatMessage({ id: 'managerBots.deleteConfirm' }, { id }))) return
    await mutation.run((expectedVersion) => ipc.config.deleteManagerBot({ id, expectedVersion }))
  }

  // owner 段收尾：普通渠道且尚无通道默认绑定 → 进助手绑定；manager（不在 channels）或已有绑定 → 结束
  const finishOwnerStage = () => {
    setPostAdd((prev) => {
      if (prev === null) return null
      const needsAssistant =
        prev.channelId in state.config.channels &&
        expandBindings(state.config.bindings).wildcard[prev.channelId] === undefined
      return needsAssistant ? { channelId: prev.channelId, stage: 'assistant' } : null
    })
  }

  return (
    <Page
      titleId="page.channels.title"
      actions={
        <Button variant="primary" onClick={() => setAdding(!adding)}>
          {intl.formatMessage({ id: 'channels.add' })}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {adding && (
          <div className="rounded-xl border border-line bg-raised p-4">
            <AddBotForm
              state={state}
              onDone={() => setAdding(false)}
              onCreated={(id) => setPostAdd({ channelId: id, stage: 'owner' })}
            />
          </div>
        )}

        {model.top.length === 0 && managers.length === 0 && !adding && (
          <div className="rounded-xl border border-dashed border-line bg-raised/50 p-6 text-sm text-ink-muted">
            {intl.formatMessage({ id: 'page.channels.empty' })}
          </div>
        )}

        {model.top.map((entry) => (
          <ChannelRow
            key={entry.id}
            id={entry.id}
            settings={entry.settings}
            identity={identityMap.get(entry.id)}
            status={statusById.get(entry.id)}
            state={state}
            editing={editing}
            setEditing={setEditing}
          />
        ))}

        {managers.map(([id, settings]) => {
          const status = managerStatusById.get(id)
          const identity = identityMap.get(id)
          const members = model.grouped.get(id) ?? []
          return (
            <div key={id} className="rounded-xl border border-line bg-raised p-4">
              <div className="flex items-center gap-3">
                <StatusDot status={status} />
                <ChannelIdentity id={id} identity={identity} badge="manager" status={status} />
                <Button variant="primary" onClick={() => setAddManagedFor(id)}>
                  {intl.formatMessage({ id: 'managerBots.addManaged' })}
                </Button>
                <Button onClick={() => setEditingManager(editingManager === id ? null : id)}>
                  {intl.formatMessage({ id: 'common.edit' })}
                </Button>
                <Button variant="danger" onClick={() => void deleteManager(id)}>
                  {intl.formatMessage({ id: 'common.delete' })}
                </Button>
              </div>

              {editingManager === id && (
                <ManagerBotForm
                  key={`${id}@${state.version}`}
                  managerId={id}
                  initial={settings}
                  state={state}
                  onDone={() => setEditingManager(null)}
                />
              )}

              {members.length > 0 && (
                // 层级引导：竖向引导线从 manager 状态点下方延伸，托管渠道行缩进挂在线上
                <div className="mt-2 ml-1 flex flex-col divide-y divide-line/70 border-l-2 border-line pl-4">
                  {members.map((entry) => (
                    <ChannelRow
                      key={entry.id}
                      id={entry.id}
                      settings={entry.settings}
                      identity={identityMap.get(entry.id)}
                      status={statusById.get(entry.id)}
                      state={state}
                      editing={editing}
                      setEditing={setEditing}
                      variant="row"
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {postAdd?.stage === 'owner' &&
        (postAdd.channelId in state.config.channels || postAdd.channelId in state.config.manager_bots) && (
          <OwnerBindModal state={state} channelId={postAdd.channelId} onClose={finishOwnerStage} />
        )}

      {postAdd?.stage === 'assistant' && postAdd.channelId in state.config.channels && (
        <ChannelDefaultBindingModal state={state} channelId={postAdd.channelId} onClose={() => setPostAdd(null)} />
      )}

      {addManagedFor !== null && addManagedFor in state.config.manager_bots && (
        <AddManagedBotModal
          state={state}
          managerId={addManagedFor}
          onClose={() => setAddManagedFor(null)}
          onAdded={(channelId) => {
            // owner 已由主进程继承 manager 的 owner：跳过 owner 段直接绑默认助手
            setAddManagedFor(null)
            setPostAdd({ channelId, stage: 'assistant' })
          }}
        />
      )}
    </Page>
  )
}
