import { describe, expect, it } from 'vitest'
import type { ChannelUser } from './config'
import {
  channelOwner,
  channelUsers,
  defaultUser,
  groupKey,
  permissionFor,
  removeUser,
  setScopePermission,
  transferOwner,
  upsertUser,
} from './users'

const owner = (channel: string, userId: string, name?: string): ChannelUser => ({
  channel,
  user_id: userId,
  role: 'owner',
  private: 'review',
  groups: {},
  ...(name === undefined ? {} : { name }),
})

const user = (channel: string, userId: string, extra: Partial<ChannelUser> = {}): ChannelUser => ({
  channel,
  user_id: userId,
  role: 'user',
  private: 'review',
  groups: {},
  ...extra,
})

const roster = [
  owner('a', '1', 'Alice'),
  user('a', '2', { private: 'allow', groups: { 'S:-100': 'allow', 'G:-4': 'ignore' } }),
  user('b', '1', { private: 'ignore' }),
]

describe('groupKey', () => {
  it('strips the thread segment, keeping chat kind and raw id', () => {
    expect(groupKey('S:-100:42')).toBe('S:-100')
    expect(groupKey('S:-100')).toBe('S:-100')
    expect(groupKey('P:7')).toBe('P:7')
  })
})

describe('permissionFor', () => {
  it('grants owner allow everywhere', () => {
    expect(permissionFor(roster, 'a', '1', 'P:1', 'private')).toBe('allow')
    expect(permissionFor(roster, 'a', '1', 'S:-999', 'supergroup')).toBe('allow')
  })

  it('resolves private and per-group levels independently for the same user', () => {
    expect(permissionFor(roster, 'a', '2', 'P:2', 'private')).toBe('allow')
    expect(permissionFor(roster, 'a', '2', 'S:-100', 'supergroup')).toBe('allow')
    expect(permissionFor(roster, 'a', '2', 'G:-4', 'group')).toBe('ignore')
    // 未设置的群 → 审核
    expect(permissionFor(roster, 'a', '2', 'S:-777', 'supergroup')).toBe('review')
  })

  it('matches group permission across threads (same group key)', () => {
    expect(permissionFor(roster, 'a', '2', 'S:-100:42', 'supergroup')).toBe('allow')
  })

  it('defaults unknown senders and null ids to review', () => {
    expect(permissionFor(roster, 'a', '999', 'P:999', 'private')).toBe('review')
    expect(permissionFor(roster, 'a', null, 'P:1', 'private')).toBe('review')
  })

  it('scopes by channel', () => {
    expect(permissionFor(roster, 'b', '1', 'P:1', 'private')).toBe('ignore')
    expect(permissionFor(roster, 'a', '1', 'P:1', 'private')).toBe('allow') // a 频道的 1 是 owner
  })
})

describe('channelOwner / channelUsers', () => {
  it('finds the channel owner, null when unbound', () => {
    expect(channelOwner(roster, 'a')?.user_id).toBe('1')
    expect(channelOwner(roster, 'b')).toBeNull()
  })

  it('filters users of a channel keeping order', () => {
    expect(channelUsers(roster, 'a').map((u) => u.user_id)).toEqual(['1', '2'])
  })
})

describe('upsertUser / removeUser', () => {
  it('appends new users and updates existing ones in place', () => {
    const added = upsertUser(roster, defaultUser('a', '3', 'Carol'))
    expect(added).toHaveLength(4)
    const updated = upsertUser(added, user('a', '3', { private: 'allow' }))
    expect(updated).toHaveLength(4)
    expect(permissionFor(updated, 'a', '3', 'P:3', 'private')).toBe('allow')
  })

  it('keeps the existing name when the update omits it', () => {
    const updated = upsertUser(roster, user('a', '2', { private: 'ignore' }))
    // 原条目无名，不受影响；有名条目保名
    const renamed = upsertUser(roster, owner('a', '1'))
    expect(renamed.find((u) => u.channel === 'a' && u.user_id === '1')?.name).toBe('Alice')
    expect(updated.find((u) => u.channel === 'a' && u.user_id === '2')?.private).toBe('ignore')
  })

  it('removes only the (channel, user) pair without mutating input', () => {
    const removed = removeUser(roster, 'a', '1')
    expect(removed).toHaveLength(2)
    expect(roster).toHaveLength(3)
  })
})

describe('setScopePermission', () => {
  it('sets the private level', () => {
    const next = setScopePermission(roster, 'a', '2', { kind: 'private' }, 'ignore')
    expect(permissionFor(next, 'a', '2', 'P:2', 'private')).toBe('ignore')
  })

  it('sets a group level and normalizes review back to an absent key', () => {
    const next = setScopePermission(roster, 'a', '2', { kind: 'group', chatId: 'S:-777:9' }, 'allow')
    expect(permissionFor(next, 'a', '2', 'S:-777', 'supergroup')).toBe('allow')

    const normalized = setScopePermission(next, 'a', '2', { kind: 'group', chatId: 'S:-777' }, 'review')
    const entry = normalized.find((u) => u.channel === 'a' && u.user_id === '2')
    expect(entry?.groups['S:-777']).toBeUndefined()
    expect(permissionFor(normalized, 'a', '2', 'S:-777', 'supergroup')).toBe('review')
  })

  it('registers unknown users on first scope assignment', () => {
    const next = setScopePermission(roster, 'a', '9', { kind: 'private' }, 'allow')
    expect(next).toHaveLength(4)
    expect(permissionFor(next, 'a', '9', 'P:9', 'private')).toBe('allow')
  })
})

describe('transferOwner', () => {
  it('promotes the new owner and demotes the previous one to user, keeping levels', () => {
    const next = transferOwner(roster, 'a', '2')
    expect(channelOwner(next, 'a')?.user_id).toBe('2')
    const demotedOwner = next.find((u) => u.channel === 'a' && u.user_id === '1')
    expect(demotedOwner?.role).toBe('user')
    // 新 owner 原有档位保留（交接回去时不丢配置）
    expect(next.find((u) => u.channel === 'a' && u.user_id === '2')?.groups['G:-4']).toBe('ignore')
    expect(next.filter((u) => u.channel === 'a' && u.role === 'owner')).toHaveLength(1)
  })

  it('registers an unknown user directly as owner', () => {
    const next = transferOwner(roster, 'b', '5', 'Eve')
    expect(channelOwner(next, 'b')?.name).toBe('Eve')
  })

  it('is a no-op promotion when the target is already owner', () => {
    const next = transferOwner(roster, 'a', '1')
    expect(channelOwner(next, 'a')?.user_id).toBe('1')
    expect(next.filter((u) => u.channel === 'a' && u.role === 'owner')).toHaveLength(1)
  })
})
