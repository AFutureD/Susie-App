import { describe, expect, it } from 'vitest'
import type { AcpAgentRow } from './registry'
import { compareAcpRows } from './registry'

const row = (overrides: Partial<AcpAgentRow>): AcpAgentRow => ({
  id: 'x',
  name: 'x',
  version: '1.0.0',
  description: '',
  installable: true,
  installedVersion: null,
  mcpHttp: null,
  ...overrides,
})

describe('compareAcpRows', () => {
  it('状态优先（已安装 > 可安装 > 不可安装），同状态按名称', () => {
    const rows = [
      row({ id: 'd', name: 'delta', installable: false }),
      row({ id: 'b', name: 'bravo' }),
      row({ id: 'c', name: 'charlie', installedVersion: '1.0.0' }),
      row({ id: 'a', name: 'alpha' }),
      row({ id: 'e', name: 'echo', installedVersion: '2.0.0' }),
    ]
    expect(rows.sort(compareAcpRows).map((item) => item.id)).toEqual(['c', 'e', 'a', 'b', 'd'])
  })
})
