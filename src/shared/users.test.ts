import { describe, expect, it } from 'vitest'
import type { ChannelUser } from './config'
import { channelOwner, channelUsers, removeUser, roleOf, transferOwner, upsertUser } from './users'

const user = (channel: string, userId: string, role: ChannelUser['role'], name?: string): ChannelUser => ({
  channel,
  user_id: userId,
  role,
  ...(name === undefined ? {} : { name }),
})

const roster = [user('a', '1', 'owner', 'Alice'), user('a', '2', 'admin'), user('b', '1', 'member')]

describe('roleOf', () => {
  it('resolves the role within the channel scope', () => {
    expect(roleOf(roster, 'a', '1')).toBe('owner')
    expect(roleOf(roster, 'b', '1')).toBe('member')
    expect(roleOf(roster, 'a', '9')).toBeNull()
    expect(roleOf(roster, 'a', null)).toBeNull()
  })
})

describe('channelOwner / channelUsers', () => {
  it('finds the channel owner, null when unbound', () => {
    expect(channelOwner(roster, 'a')?.user_id).toBe('1')
    expect(channelOwner(roster, 'b')).toBeNull()
    expect(channelOwner([], 'a')).toBeNull()
  })

  it('filters users of a channel keeping order', () => {
    expect(channelUsers(roster, 'a').map((u) => u.user_id)).toEqual(['1', '2'])
  })
})

describe('upsertUser / removeUser', () => {
  it('appends new users and updates existing ones in place', () => {
    const added = upsertUser(roster, user('a', '3', 'member', 'Carol'))
    expect(added).toHaveLength(4)
    const updated = upsertUser(added, user('a', '3', 'admin'))
    expect(updated).toHaveLength(4)
    expect(roleOf(updated, 'a', '3')).toBe('admin')
  })

  it('keeps the existing name when the update omits it', () => {
    const updated = upsertUser(roster, user('a', '1', 'admin'))
    expect(updated.find((u) => u.channel === 'a' && u.user_id === '1')?.name).toBe('Alice')
  })

  it('removes only the (channel, user) pair', () => {
    const removed = removeUser(roster, 'a', '1')
    expect(removed).toHaveLength(2)
    expect(roleOf(removed, 'b', '1')).toBe('member')
  })

  it('does not mutate the input array', () => {
    upsertUser(roster, user('a', '9', 'member'))
    removeUser(roster, 'a', '1')
    expect(roster).toHaveLength(3)
  })
})

describe('transferOwner', () => {
  it('promotes the new owner and demotes the previous one to admin', () => {
    const next = transferOwner(roster, 'a', '2')
    expect(roleOf(next, 'a', '2')).toBe('owner')
    expect(roleOf(next, 'a', '1')).toBe('admin')
    expect(next.filter((u) => u.channel === 'a' && u.role === 'owner')).toHaveLength(1)
  })

  it('registers an unknown user directly as owner', () => {
    const next = transferOwner(roster, 'b', '5', 'Eve')
    expect(roleOf(next, 'b', '5')).toBe('owner')
    expect(next.find((u) => u.channel === 'b' && u.user_id === '5')?.name).toBe('Eve')
  })

  it('is a no-op promotion when the target is already owner', () => {
    const next = transferOwner(roster, 'a', '1')
    expect(roleOf(next, 'a', '1')).toBe('owner')
    expect(next.filter((u) => u.channel === 'a' && u.role === 'owner')).toHaveLength(1)
  })
})
