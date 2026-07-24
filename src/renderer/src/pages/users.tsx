import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { USER_ROLES, type ChannelUser, type ConfigState, type UserRole } from '../../../shared/config'
import { channelOwner, channelUsers, removeUser, transferOwner, upsertUser } from '../../../shared/users'
import { Button, Select } from '../components/form'
import { MemberPickerModal, useSenders } from '../components/member-picker'
import { Page } from '../components/page'
import { configStateAtom } from '../lib/config-atoms'
import { susie } from '../lib/ipc'

// 用户管理：按频道维护已登记用户与角色（owner 唯一；admin 免审；member 消息需 owner 审核）。
// 名单存 config.users；候选来自历史库发送者（发过消息即出现，实时刷新）。

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
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const users = channelUsers(state.config.users, channelId)
  const owner = channelOwner(state.config.users, channelId)

  const displayName = (user: ChannelUser): string =>
    user.name ?? senders.find((sender) => sender.id === user.user_id)?.name ?? user.user_id

  const save = async (next: ChannelUser[]): Promise<void> => {
    if (busy) return
    setBusy(true)
    const result = await susie.invoke('config:set-users', { users: next, expectedVersion: state.version })
    setBusy(false)
    if (!result.ok) {
      window.alert(result.conflict ? intl.formatMessage({ id: 'bindings.error.conflictRefreshed' }) : result.message)
    }
  }

  const changeRole = (user: ChannelUser, role: UserRole): void => {
    if (role === user.role) return
    if (role === 'owner') {
      if (
        owner !== null &&
        owner.user_id !== user.user_id &&
        !window.confirm(intl.formatMessage({ id: 'users.transfer.confirm' }, { name: displayName(user) }))
      ) {
        return
      }
      void save(transferOwner(state.config.users, channelId, user.user_id, user.name))
      return
    }
    if (
      user.role === 'owner' &&
      !window.confirm(intl.formatMessage({ id: 'users.demote.confirm' }, { name: displayName(user) }))
    ) {
      return
    }
    void save(upsertUser(state.config.users, { ...user, role }))
  }

  const remove = (user: ChannelUser): void => {
    const key = user.role === 'owner' ? 'users.remove.owner.confirm' : 'users.remove.confirm'
    if (!window.confirm(intl.formatMessage({ id: key }, { name: displayName(user) }))) return
    void save(removeUser(state.config.users, channelId, user.user_id))
  }

  const addMember = (id: string): void => {
    const name = senders.find((sender) => sender.id === id)?.name
    void save(
      upsertUser(state.config.users, {
        channel: channelId,
        user_id: id,
        role: 'member',
        ...(name == null ? {} : { name }),
      }),
    )
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
          <Button disabled={busy} onClick={() => setPickerOpen(true)}>
            {intl.formatMessage({ id: 'users.add' })}
          </Button>
        )}
      </div>

      {owner === null && !ghost && (
        <p className="mt-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-600">
          {intl.formatMessage({ id: 'users.channel.noOwner' })}
        </p>
      )}

      {users.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">{intl.formatMessage({ id: 'users.roster.empty' })}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-1">
          {users.map((user) => (
            <div key={user.user_id} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-line/20">
              <div className="min-w-0 flex-1">
                <span className="block truncate text-sm">{displayName(user)}</span>
                <span className="block font-mono text-[11px] text-ink-muted select-text">{user.user_id}</span>
              </div>
              <Select
                value={user.role}
                disabled={busy}
                className="w-28"
                onChange={(event) => changeRole(user, event.target.value as UserRole)}
              >
                {USER_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {intl.formatMessage({ id: `users.role.${role}` })}
                  </option>
                ))}
              </Select>
              <Button variant="danger" disabled={busy} onClick={() => remove(user)}>
                {intl.formatMessage({ id: 'common.delete' })}
              </Button>
            </div>
          ))}
        </div>
      )}

      {pickerOpen && (
        <MemberPickerModal
          channelId={channelId}
          existing={new Set(users.map((user) => user.user_id))}
          busy={busy}
          onAdd={addMember}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
