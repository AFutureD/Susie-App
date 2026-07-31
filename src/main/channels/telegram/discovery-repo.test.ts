import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../../db/database'
import { DiscoveryRepo, type StoredManagedBotDiscovery } from './discovery-repo'

function makeRepo(): DiscoveryRepo {
  return new DiscoveryRepo(new AppDatabase(':memory:'))
}

function discovery(overrides: Partial<StoredManagedBotDiscovery> = {}): StoredManagedBotDiscovery {
  return {
    managerId: 'mgr',
    botId: '999',
    username: 'child_bot',
    name: 'Child',
    creatorId: '7',
    creatorName: 'Boss',
    discoveredTs: 1000,
    ...overrides,
  }
}

describe('DiscoveryRepo', () => {
  it('upsert 幂等：同 (manager, bot) 覆盖为最新 username/name', () => {
    const repo = makeRepo()
    repo.upsert(discovery())
    repo.upsert(discovery({ username: 'renamed_bot', name: 'Renamed', discoveredTs: 2000 }))

    const list = repo.listByManager('mgr')
    expect(list).toHaveLength(1)
    expect(list[0]?.username).toBe('renamed_bot')
    expect(list[0]?.discoveredTs).toBe(2000)
  })

  it('listByManager 只含本 manager，新 → 旧', () => {
    const repo = makeRepo()
    repo.upsert(discovery({ botId: '1', discoveredTs: 100 }))
    repo.upsert(discovery({ botId: '2', discoveredTs: 300 }))
    repo.upsert(discovery({ managerId: 'other', botId: '3' }))

    expect(repo.listByManager('mgr').map((d) => d.botId)).toEqual(['2', '1'])
    expect(repo.get('mgr', '1')?.botId).toBe('1')
    expect(repo.get('mgr', 'nope')).toBeNull()
  })

  it('delete 与 deleteByManager', () => {
    const repo = makeRepo()
    repo.upsert(discovery({ botId: '1' }))
    repo.upsert(discovery({ botId: '2' }))

    repo.delete('mgr', '1')
    expect(repo.listByManager('mgr').map((d) => d.botId)).toEqual(['2'])

    repo.deleteByManager('mgr')
    expect(repo.listByManager('mgr')).toEqual([])
  })
})
