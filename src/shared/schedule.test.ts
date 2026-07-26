import { describe, expect, it } from 'vitest'
import { cronMatches, nextRunAt, parseCron } from './schedule'

// 本地时区构造时刻（cron 语义就是本地时间）
const at = (y: number, mo: number, d: number, h: number, mi: number): Date => new Date(y, mo - 1, d, h, mi)

function matches(expr: string, date: Date): boolean {
  const spec = parseCron(expr)
  if (spec === null) throw new Error(`表达式应合法：${expr}`)
  return cronMatches(spec, date)
}

function next(expr: string, from: Date): Date | null {
  const spec = parseCron(expr)
  if (spec === null) throw new Error(`表达式应合法：${expr}`)
  const ts = nextRunAt(spec, from.getTime())
  return ts === null ? null : new Date(ts)
}

describe('parseCron', () => {
  it('接受支持的子集：*、*/step、数字、区间、列表', () => {
    expect(parseCron('* * * * *')).not.toBeNull()
    expect(parseCron('*/15 * * * *')).not.toBeNull()
    expect(parseCron('0 9 * * 1,3,5')).not.toBeNull()
    expect(parseCron('30 8 1-5,15 * *')).not.toBeNull()
    expect(parseCron('  0   9 * * *  ')).not.toBeNull()
  })

  it('拒绝：字段数不对、越界、步长为零、别名等', () => {
    expect(parseCron('* * * *')).toBeNull()
    expect(parseCron('* * * * * *')).toBeNull()
    expect(parseCron('60 * * * *')).toBeNull()
    expect(parseCron('* 24 * * *')).toBeNull()
    expect(parseCron('* * 0 * *')).toBeNull()
    expect(parseCron('* * * 13 *')).toBeNull()
    expect(parseCron('* * * * 7')).toBeNull()
    expect(parseCron('*/0 * * * *')).toBeNull()
    expect(parseCron('5-1 * * * *')).toBeNull()
    expect(parseCron('1,, * * * *')).toBeNull()
    expect(parseCron('MON * * * *')).toBeNull()
    expect(parseCron('0 9 * * 1-5/2')).toBeNull()
  })
})

describe('cronMatches', () => {
  it('每天 HH:MM 只在该分钟命中', () => {
    expect(matches('0 9 * * *', at(2026, 7, 27, 9, 0))).toBe(true)
    expect(matches('0 9 * * *', at(2026, 7, 27, 9, 1))).toBe(false)
    expect(matches('0 9 * * *', at(2026, 7, 27, 10, 0))).toBe(false)
  })

  it('*/15 对齐整点的 0/15/30/45 分', () => {
    expect(matches('*/15 * * * *', at(2026, 7, 27, 9, 0))).toBe(true)
    expect(matches('*/15 * * * *', at(2026, 7, 27, 9, 30))).toBe(true)
    expect(matches('*/15 * * * *', at(2026, 7, 27, 9, 7))).toBe(false)
  })

  it('每周多选（2026-07-27 是周一）', () => {
    expect(matches('0 9 * * 1,3', at(2026, 7, 27, 9, 0))).toBe(true)
    expect(matches('0 9 * * 1,3', at(2026, 7, 28, 9, 0))).toBe(false) // 周二
    expect(matches('0 9 * * 1,3', at(2026, 7, 29, 9, 0))).toBe(true) // 周三
  })

  it('日与周同时受限按 vixie 取并集（OR）', () => {
    // 2026-04-13 是周一：命中 dom=13；2026-04-17 是周五：命中 dow=5；2026-04-14 周二两者皆非
    expect(matches('0 9 13 * 5', at(2026, 4, 13, 9, 0))).toBe(true)
    expect(matches('0 9 13 * 5', at(2026, 4, 17, 9, 0))).toBe(true)
    expect(matches('0 9 13 * 5', at(2026, 4, 14, 9, 0))).toBe(false)
  })
})

describe('nextRunAt', () => {
  it('严格晚于 from：正好在触发分钟时给下一次', () => {
    expect(next('0 9 * * *', at(2026, 7, 27, 8, 59))).toEqual(at(2026, 7, 27, 9, 0))
    expect(next('0 9 * * *', at(2026, 7, 27, 9, 0))).toEqual(at(2026, 7, 28, 9, 0))
  })

  it('每周跨周推进（周一 9:00，从周二起算 → 下周一）', () => {
    expect(next('0 9 * * 1', at(2026, 7, 28, 10, 0))).toEqual(at(2026, 8, 3, 9, 0))
  })

  it('每月 31 日自动跳过小月', () => {
    // 2026-02-01 起算：2 月没有 31 日 → 3 月 31 日
    expect(next('0 9 31 * *', at(2026, 2, 1, 0, 0))).toEqual(at(2026, 3, 31, 9, 0))
  })

  it('永不触发的表达式返回 null（2 月 30 日）', () => {
    expect(next('0 0 30 2 *', at(2026, 1, 1, 0, 0))).toBeNull()
  })
})
