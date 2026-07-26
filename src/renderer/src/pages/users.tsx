import { useMemo, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { PERMISSION_LEVELS, type ChannelUser, type ConfigState, type PermissionLevel } from '../../../shared/config'
import { decodeChatId } from '../../../shared/chat-id'
import {
  channelOwner,
  channelUsers,
  defaultUser,
  groupKey,
  removeUser,
  setScopePermission,
  transferOwner,
  upsertUser,
  type PermissionScope,
} from '../../../shared/users'
import { Button, Select } from '../components/form'
import { MemberPickerModal, useSenders } from '../components/member-picker'
import { OwnerBindModal } from '../components/owner-bind'
import { Page } from '../components/page'
import { configStateAtom } from '../lib/config-atoms'
import { ipc } from '../lib/ipc'
import { useChatsQuery } from '../lib/ipc-query'
import { useConfigMutation } from '../lib/ipc-mutation'

// 用户管理 = 身份轴：owner 全局直通并负责审核；其余用户按范围（私聊 / 具体群）三档
// （直通 / 审核 / 忽略）。未登记发送者与未设置的范围默认审核，批准后自动登记。
// 会话绑定只负责路由（会话 → 助手），不参与权限。

/** 已知群（供每用户的群档位矩阵）：按 groupKey 去重（thread 归并到群） */
interface KnownGroup {
  key: string
  name: string | null
}

function useChannelGroups(channelId: string): KnownGroup[] {
  // 共享查询缓存（history.message 事件自动失效）；本 hook 只做按频道的派生计算
  const { data } = useChatsQuery()
  return useMemo(() => {
    if (channelId === '' || data === null) return []
    const byKey = new Map<string, string | null>()
    for (const chat of data) {
      if (chat.channelId !== channelId) continue
      const chatType = decodeChatId(chat.chatId)?.chatType ?? null
      if (chatType !== 'group' && chatType !== 'supergroup') continue
      const key = groupKey(chat.chatId)
      if (!byKey.has(key) || byKey.get(key) === null) byKey.set(key, chat.name)
    }
    return [...byKey.entries()].map(([key, name]) => ({ key, name }))
  }, [data, channelId])
}

export function UsersPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)

  if (!state) {
    return <Page titleId="page.users.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  // 频道全集：config.channels ∪ 名单里引用的幽灵频道（频道删除不级联清理用户）
  const channelIds = [
    ...new Set([...Object.keys(state.config.channels), ...state.config.users.map((user) => user.channel)]),
  ]

  return (
    <Page titleId="page.users.title">
      <div className="flex flex-col gap-3">
        <p className="text-xs leading-5 text-ink-muted">{intl.formatMessage({ id: 'users.hint' })}</p>
        {channelIds.length === 0 && (
          <div className="rounded-xl border border-dashed border-line bg-raised/50 p-6 text-sm text-ink-muted">
            {intl.formatMessage({ id: 'users.empty' })}
          </div>
        )}
        {channelIds.map((channelId) => (
          <ChannelUsersCard
            key={channelId}
            state={state}
            channelId={channelId}
            ghost={!(channelId in state.config.channels)}
          />
        ))}
      </div>
    </Page>
  )
}

function ChannelUsersCard({ state, channelId, ghost }: { state: ConfigState; channelId: string; ghost: boolean }) {
  const intl = useIntl()
  const senders = useSenders(ghost ? '' : channelId)
  const knownGroups = useChannelGroups(ghost ? '' : channelId)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [ownerBindOpen, setOwnerBindOpen] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const users = channelUsers(state.config.users, channelId).toSorted(
    (a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1),
  )
  const mutation = useConfigMutation()
  const owner = channelOwner(state.config.users, channelId)

  const displayName = (user: ChannelUser): string =>
    user.name ?? senders.find((sender) => sender.id === user.user_id)?.name ?? user.user_id

  const save = async (next: ChannelUser[]): Promise<void> => {
    if (mutation.busy) return
    await mutation.run((expectedVersion) => ipc.config.setUsers({ users: next, expectedVersion }))
  }

  const setScope = (user: ChannelUser, scope: PermissionScope, level: PermissionLevel): void => {
    void save(setScopePermission(state.config.users, channelId, user.user_id, scope, level))
  }

  const makeOwner = (user: ChannelUser): void => {
    if (
      owner !== null &&
      !window.confirm(intl.formatMessage({ id: 'users.transfer.confirm' }, { name: displayName(user) }))
    ) {
      return
    }
    void save(transferOwner(state.config.users, channelId, user.user_id, user.name))
  }

  const remove = (user: ChannelUser): void => {
    const key = user.role === 'owner' ? 'users.remove.owner.confirm' : 'users.remove.confirm'
    if (!window.confirm(intl.formatMessage({ id: key }, { name: displayName(user) }))) return
    void save(removeUser(state.config.users, channelId, user.user_id))
  }

  const addMember = (id: string): void => {
    const name = senders.find((sender) => sender.id === id)?.name
    void save(upsertUser(state.config.users, defaultUser(channelId, id, name)))
  }

  return (
    <div className="rounded-xl border border-line bg-raised p-4">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-semibold">{channelId}</span>
        {ghost && (
          <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-500">
            {intl.formatMessage({ id: 'users.ghost' })}
          </span>
        )}
        <div className="flex-1" />
        {!ghost && (
          <Button disabled={mutation.busy} onClick={() => setPickerOpen(true)}>
            {intl.formatMessage({ id: 'users.add' })}
          </Button>
        )}
      </div>

      {owner === null && !ghost && (
        <div className="mt-2 flex items-center gap-3">
          <p className="min-w-0 flex-1 text-xs text-red-500">{intl.formatMessage({ id: 'users.channel.noOwner' })}</p>
          <Button className="shrink-0" disabled={mutation.busy} onClick={() => setOwnerBindOpen(true)}>
            {intl.formatMessage({ id: 'ownerBind.title' })}
          </Button>
        </div>
      )}

      {users.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">{intl.formatMessage({ id: 'users.roster.empty' })}</p>
      ) : (
        <div className="mt-2 divide-y divide-line/60">
          {users.map((user) => (
            <UserRow
              key={user.user_id}
              user={user}
              name={displayName(user)}
              knownGroups={knownGroups}
              expanded={expandedId === user.user_id}
              busy={mutation.busy}
              onToggle={() => setExpandedId(expandedId === user.user_id ? null : user.user_id)}
              onScope={(scope, level) => setScope(user, scope, level)}
              onMakeOwner={() => makeOwner(user)}
              onRemove={() => remove(user)}
            />
          ))}
        </div>
      )}

      {pickerOpen && (
        <MemberPickerModal
          channelId={channelId}
          existing={new Set(users.map((user) => user.user_id))}
          busy={mutation.busy}
          onAdd={addMember}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {ownerBindOpen && <OwnerBindModal state={state} channelId={channelId} onClose={() => setOwnerBindOpen(false)} />}
    </div>
  )
}

function LevelSelect({
  value,
  disabled,
  onChange,
}: {
  value: PermissionLevel
  disabled: boolean
  onChange: (level: PermissionLevel) => void
}) {
  const intl = useIntl()
  return (
    <div className="w-24 shrink-0">
      <Select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as PermissionLevel)}>
        {PERMISSION_LEVELS.map((level) => (
          <option key={level} value={level}>
            {intl.formatMessage({ id: `users.level.${level}` })}
          </option>
        ))}
      </Select>
    </div>
  )
}

function UserRow({
  user,
  name,
  knownGroups,
  expanded,
  busy,
  onToggle,
  onScope,
  onMakeOwner,
  onRemove,
}: {
  user: ChannelUser
  name: string
  knownGroups: KnownGroup[]
  expanded: boolean
  busy: boolean
  onToggle: () => void
  onScope: (scope: PermissionScope, level: PermissionLevel) => void
  onMakeOwner: () => void
  onRemove: () => void
}) {
  const intl = useIntl()
  const isOwner = user.role === 'owner'
  const hasName = user.name !== undefined || name !== user.user_id

  return (
    <div className="py-2.5">
      <div className="flex items-center gap-4">
        <div className="min-w-0 flex-1">
          {hasName ? (
            <>
              <span className="block truncate text-sm">{name}</span>
              <span className="block font-mono text-[11px] text-ink-muted select-text">{user.user_id}</span>
            </>
          ) : (
            <span className="block truncate font-mono text-sm select-text">{user.user_id}</span>
          )}
        </div>

        {isOwner ? (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
            {intl.formatMessage({ id: 'users.owner.badge' })}
          </span>
        ) : (
          <>
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-muted">
              {intl.formatMessage({ id: 'users.scope.private' })}
              <LevelSelect
                value={user.private}
                disabled={busy}
                onChange={(level) => onScope({ kind: 'private' }, level)}
              />
            </label>
            <button
              type="button"
              onClick={onToggle}
              className="shrink-0 text-xs whitespace-nowrap text-ink-muted transition-colors hover:text-ink"
            >
              {intl.formatMessage({ id: 'users.scope.groups' })} {expanded ? '▾' : '▸'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={onMakeOwner}
              className="shrink-0 text-xs whitespace-nowrap text-ink-muted transition-colors hover:text-ink disabled:opacity-40"
            >
              {intl.formatMessage({ id: 'users.makeOwner' })}
            </button>
          </>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={onRemove}
          className="shrink-0 text-xs whitespace-nowrap text-ink-muted transition-colors hover:text-red-500 disabled:opacity-40"
        >
          {intl.formatMessage({ id: 'users.remove' })}
        </button>
      </div>

      {expanded && !isOwner && (
        <div className="mt-2 ml-1 flex flex-col gap-1.5 border-l border-line pl-4">
          {knownGroups.length === 0 ? (
            <p className="py-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'users.scope.groups.empty' })}</p>
          ) : (
            knownGroups.map((group) => (
              <div key={group.key} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <span className={`block truncate text-sm ${group.name === null ? 'font-mono text-xs' : ''}`}>
                    {group.name ?? group.key}
                  </span>
                </div>
                <LevelSelect
                  value={user.groups[group.key] ?? 'review'}
                  disabled={busy}
                  onChange={(level) => onScope({ kind: 'group', chatId: group.key }, level)}
                />
              </div>
            ))
          )}
          <p className="py-0.5 text-[11px] text-ink-muted/70">
            {intl.formatMessage({ id: 'users.scope.groups.hint' })}
          </p>
        </div>
      )}
    </div>
  )
}
