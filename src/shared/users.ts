import type { ChannelUser, UserRole } from './config'

// 用户角色的纯函数集（对位 bindings.ts 的风格）：查询 + 供 UI 复用的不可变变换。
// 语义：owner/admin 消息直通；member 与未登记发送者需 owner 审核；频道无 owner 时无人可审 → 忽略。

export function roleOf(users: ChannelUser[], channelId: string, senderId: string | null): UserRole | null {
  if (senderId === null) return null
  return users.find((user) => user.channel === channelId && user.user_id === senderId)?.role ?? null
}

export function channelOwner(users: ChannelUser[], channelId: string): ChannelUser | null {
  return users.find((user) => user.channel === channelId && user.role === 'owner') ?? null
}

/** 频道内的用户（保持声明序） */
export function channelUsers(users: ChannelUser[], channelId: string): ChannelUser[] {
  return users.filter((user) => user.channel === channelId)
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

/** owner 交接：新 owner 登记/升级，原 owner 降为 admin（schema 保证每频道 owner 唯一） */
export function transferOwner(
  users: ChannelUser[],
  channelId: string,
  newOwnerId: string,
  name?: string,
): ChannelUser[] {
  const demoted = users.map((user): ChannelUser => {
    if (user.channel === channelId && user.role === 'owner' && user.user_id !== newOwnerId) {
      return { ...user, role: 'admin' }
    }
    return user
  })
  return upsertUser(demoted, { channel: channelId, user_id: newOwnerId, name, role: 'owner' })
}
