import { describe, expect, it } from 'vitest'
import { fromCron, toCron, type SchedulePreset } from './model'

// 预设 ⇄ cron 互转：UI 只见预设，存储只见 cron。

describe('toCron / fromCron 往返', () => {
  const cases: [SchedulePreset, string][] = [
    [{ kind: 'every_minutes', minutes: 15 }, '*/15 * * * *'],
    [{ kind: 'hourly', minute: 30 }, '30 * * * *'],
    [{ kind: 'daily', time: '09:05' }, '5 9 * * *'],
    [{ kind: 'weekly', weekdays: [1, 3, 5], time: '09:00' }, '0 9 * * 1,3,5'],
    [{ kind: 'monthly', days: [1, 15], time: '20:30' }, '30 20 1,15 * *'],
  ]

  it.each(cases)('%j ⇄ %s', (preset, cron) => {
    expect(toCron(preset)).toBe(cron)
    expect(fromCron(cron)).toEqual(preset)
  })

  it('生成时去重排序（存储形态稳定）', () => {
    expect(toCron({ kind: 'weekly', weekdays: [5, 1, 3, 3], time: '09:00' })).toBe('0 9 * * 1,3,5')
  })
})

describe('fromCron 反解析边界', () => {
  it('认不出的手写表达式返回 null（UI 按「自定义」保留）', () => {
    expect(fromCron('0 */2 * * *')).toBeNull() // 每 2 小时：预设不覆盖
    expect(fromCron('0 9 13 * 5')).toBeNull() // 日 + 周双限
    expect(fromCron('0 9 1-5 * *')).toBeNull() // 区间
    expect(fromCron('0 9 * 6 *')).toBeNull() // 指定月份
    expect(fromCron('not cron')).toBeNull()
  })

  it('越界值不落入预设', () => {
    expect(fromCron('*/60 * * * *')).toBeNull()
    expect(fromCron('0 9 * * 9')).toBeNull()
  })
})
