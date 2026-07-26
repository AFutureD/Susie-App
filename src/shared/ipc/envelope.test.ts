import { describe, expect, it } from 'vitest'
import { isErrorEnvelope, reviveError, toErrorEnvelope } from './envelope'

describe('IPC 错误信封', () => {
  it('往返保真：name / message / code / cause 链', () => {
    const root = new Error('磁盘写入失败')
    root.name = 'IOError'
    ;(root as Error & { code?: string }).code = 'ENOSPC'
    const wrapped = new Error('配置保存失败', { cause: root })

    const envelope = toErrorEnvelope(wrapped)
    expect(isErrorEnvelope(envelope)).toBe(true)

    const revived = reviveError(envelope)
    expect(revived).toBeInstanceOf(Error)
    expect(revived.message).toBe('配置保存失败')
    expect(revived.cause).toBeInstanceOf(Error)
    const cause = revived.cause as Error & { code?: string }
    expect(cause.message).toBe('磁盘写入失败')
    expect(cause.name).toBe('IOError')
    expect(cause.code).toBe('ENOSPC')
  })

  it('cause 链深度封顶（5 层）', () => {
    let error = new Error('level-0')
    for (let level = 1; level <= 8; level += 1) {
      error = new Error(`level-${level}`, { cause: error })
    }
    const envelope = toErrorEnvelope(error)
    let depth = 0
    let cursor = envelope.cause
    while (cursor !== undefined) {
      depth += 1
      cursor = cursor.cause
    }
    expect(depth).toBe(5)
  })

  it('非 Error 值：String 化为 message', () => {
    expect(toErrorEnvelope('boom').message).toBe('boom')
    expect(toErrorEnvelope(42).message).toBe('42')
    expect(reviveError(toErrorEnvelope('boom')).message).toBe('boom')
  })

  it('isErrorEnvelope 只认 marker', () => {
    expect(isErrorEnvelope(null)).toBe(false)
    expect(isErrorEnvelope(undefined)).toBe(false)
    expect(isErrorEnvelope({ ok: false, message: 'x' })).toBe(false)
    expect(isErrorEnvelope({ __susieIpcError__: 'yes' })).toBe(false)
    expect(isErrorEnvelope(toErrorEnvelope(new Error('x')))).toBe(true)
  })

  it('保留 stack（诊断用）', () => {
    const envelope = toErrorEnvelope(new Error('trace me'))
    expect(envelope.stack).toContain('trace me')
    expect(reviveError(envelope).stack).toBe(envelope.stack)
  })
})
