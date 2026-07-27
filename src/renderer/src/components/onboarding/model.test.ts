import { describe, expect, it } from 'vitest'
import { shouldOnboard } from './model'

describe('shouldOnboard', () => {
  it('首启（本次启动时 config.toml 不存在）→ 进入', () => {
    expect(shouldOnboard({ firstRun: true, lastError: null })).toBe(true)
  })

  it('config.toml 已存在 → 不进入（无论内容多不完整）', () => {
    expect(shouldOnboard({ firstRun: false, lastError: null })).toBe(false)
  })

  it('配置损坏（last-good 运行）→ 不进入，错误横幅负责提示', () => {
    expect(shouldOnboard({ firstRun: false, lastError: 'TOML 解析失败' })).toBe(false)
    // 理论上首启即损坏（默认文件写入后被并发改坏）也不进——向导写入会覆盖现场
    expect(shouldOnboard({ firstRun: true, lastError: '读取配置失败' })).toBe(false)
  })
})
