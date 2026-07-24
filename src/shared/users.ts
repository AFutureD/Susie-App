import { DEFAULT_PERMISSION, type ChannelUser, type PermissionLevel } from './config'

// 身份轴的纯函数集（对位 bindings.ts 的风格）：owner 全局直通并负责审核；
// 其余用户按范围（私聊 / 具体群）三档控制：allow 直通、review 审核、ignore 忽略。
// 未登记的发送者与未设置的范围一律按 DEFAULT_PERMISSION（审核）。

/** 群权限的 key：剥离 thread 段（权限按群不按话题，S:-1:42 → S:-1） */
export function groupKey(chatId: string): string {
  const parts = chatId.split(':')
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : chatId
}

export function findUser(users: ChannelUser[], channelId: string, userId: string | null): ChannelUser | null {
  if (userId === null) return null
  return users.find((user) => user.channel === channelId && user.user_id === userId) ?? null
}

export function channelOwner(users: ChannelUser[], channelId: string): ChannelUser | null {
  return users.find((user) => user.channel === channelId && user.role === 'owner') ?? null
}

/** 频道内的用户（保持声明序） */
export function channelUsers(users: ChannelUser[], channelId: string): ChannelUser[] {
  return users.filter((user) => user.channel === channelId)
}

/** 新登记用户的缺省形态（各范围均为审核档） */
export function defaultUser(channel: string, userId: string, name?: string | null): ChannelUser {
  return {
    channel,
    user_id: userId,
    role: 'user',
    private: DEFAULT_PERMISSION,
    groups: {},
    ...(name == null ? {} : { name }),
  }
}

/**
 * 范围权限判定：owner 全局直通；私聊查 private 档；群查 groups[groupKey] 档；
 * 未登记 / 未设置 → DEFAULT_PERMISSION（审核）。
 */
export function permissionFor(
  users: ChannelUser[],
  channelId: string,
  senderId: string | null,
  chatId: string,
  chatType: string | null,
): PermissionLevel {
  const user = findUser(users, channelId, senderId)
  if (user === null) return DEFAULT_PERMISSION
  if (user.role === 'owner') return 'allow'
  if (chatType === 'private') return user.private
  return user.groups[groupKey(chatId)] ?? DEFAULT_PERMISSION
}

/** 新增或更新（按 channel+user_id 定位）；name 传 undefined 时保留原值 */
export function upsertUser(users: ChannelUser[], user: ChannelUser): ChannelUser[] {
  const index = users.findIndex((u) => u.channel === user.channel && u.user_id === user.user_id)
  if (index < 0) return [...users, user]
  const existing = users[index] as ChannelUser
  const next = [...users]
  next[index] = { ...user, name: user.name ?? existing.name }
  return next
}

export function removeUser(users: ChannelUser[], channelId: string, userId: string): ChannelUser[] {
  return users.filter((user) => !(user.channel === channelId && user.user_id === userId))
}

export type PermissionScope = { kind: 'private' } | { kind: 'group'; chatId: string }

/** 设置某用户某范围的档位；群档位等于缺省值时删键归一化（TOML 最小化）。用户不存在时先登记。 */
export function setScopePermission(
  users: ChannelUser[],
  channelId: string,
  userId: string,
  scope: PermissionScope,
  level: PermissionLevel,
): ChannelUser[] {
  const existing = findUser(users, channelId, userId) ?? defaultUser(channelId, userId)
  if (scope.kind === 'private') {
    return upsertUser(users, { ...existing, private: level })
  }
  const key = groupKey(scope.chatId)
  const groups = { ...existing.groups }
  if (level === DEFAULT_PERMISSION) delete groups[key]
  else groups[key] = level
  return upsertUser(users, { ...existing, groups })
}

/** owner 交接：新 owner 登记/升级（保留其已有档位），原 owner 降为 user（档位保留） */
export function transferOwner(
  users: ChannelUser[],
  channelId: string,
  newOwnerId: string,
  name?: string,
): ChannelUser[] {
  const demoted = users.map((user): ChannelUser => {
    if (user.channel === channelId && user.role === 'owner' && user.user_id !== newOwnerId) {
      return { ...user, role: 'user' }
    }
    return user
  })
  const existing = findUser(demoted, channelId, newOwnerId)
  return upsertUser(demoted, {
    ...(existing ?? defaultUser(channelId, newOwnerId)),
    role: 'owner',
    ...(name === undefined ? {} : { name }),
  })
}
