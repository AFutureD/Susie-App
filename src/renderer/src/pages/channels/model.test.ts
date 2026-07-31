import { describe, expect, it } from 'vitest'
import type { ChannelSettings } from '../../../../shared/config'
import { buildChannelList } from './model'

const bot = (token: string): ChannelSettings => ({
  type: 'telegram_bot',
  token,
  enabled: true,
  drop_pending_updates: false,
})

describe('buildChannelList', () => {
  it('managing 命中的渠道进分组，其余顶层', () => {
    const model = buildChannelList(
      { a: bot('1:a'), b: bot('2:b'), c: bot('3:c') },
      { mgr: { token: '9:m', managing: ['b'] } },
    )
    expect(model.top.map((e) => e.id)).toEqual(['a', 'c'])
    expect(model.grouped.get('mgr')?.map((e) => e.id)).toEqual(['b'])
  })

  it('幽灵引用忽略；重复认领先声明者赢', () => {
    const model = buildChannelList(
      { b: bot('2:b') },
      {
        mgr1: { token: '9:m', managing: ['b', 'ghost'] },
        mgr2: { token: '8:n', managing: ['b'] },
      },
    )
    expect(model.grouped.get('mgr1')?.map((e) => e.id)).toEqual(['b'])
    expect(model.grouped.get('mgr2')).toEqual([])
    expect(model.top).toEqual([])
  })

  it('无 manager 时全部顶层', () => {
    const model = buildChannelList({ a: bot('1:a') }, {})
    expect(model.top.map((e) => e.id)).toEqual(['a'])
    expect(model.grouped.size).toBe(0)
  })
})
