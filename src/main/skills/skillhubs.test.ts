import { describe, expect, it } from 'vitest'
import { mapRegistryEntry, pickLatestVersion } from './skillhubs'

describe('mapRegistryEntry', () => {
  it('完整字段映射（download_count → downloadCount）', () => {
    expect(
      mapRegistryEntry({
        name: 'debt-tracker',
        version: '1.2.0',
        description: '记账',
        author: 'inston',
        download_count: 42,
        tags: ['finance', 7, 'tool'],
      }),
    ).toEqual({
      name: 'debt-tracker',
      version: '1.2.0',
      description: '记账',
      author: 'inston',
      downloadCount: 42,
      tags: ['finance', 'tool'],
    })
  })

  it('字段缺失容忍；无有效 name 返回 null', () => {
    expect(mapRegistryEntry({ name: 'bare' })).toEqual({
      name: 'bare',
      version: '',
      description: '',
      author: null,
      downloadCount: null,
      tags: [],
    })
    expect(mapRegistryEntry({ version: '1.0.0' })).toBeNull()
    expect(mapRegistryEntry('oops')).toBeNull()
    expect(mapRegistryEntry(null)).toBeNull()
  })
})

describe('pickLatestVersion', () => {
  it('裸数组与 { versions } 包裹均可，取 [0].version', () => {
    expect(pickLatestVersion([{ version: '2.0.0' }, { version: '1.0.0' }])).toBe('2.0.0')
    expect(pickLatestVersion({ versions: [{ version: '3.1.4' }] })).toBe('3.1.4')
  })

  it('空列表 / 形状不符返回 null', () => {
    expect(pickLatestVersion([])).toBeNull()
    expect(pickLatestVersion({ versions: [] })).toBeNull()
    expect(pickLatestVersion({ versions: [{ ver: 'x' }] })).toBeNull()
    expect(pickLatestVersion('nope')).toBeNull()
  })
})
