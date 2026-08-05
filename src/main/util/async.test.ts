import { describe, expect, it } from 'vitest'
import { sleep } from './async'

describe('sleep', () => {
  it('abort 立即 resolve（不 reject）', async () => {
    const controller = new AbortController()
    const start = Date.now()
    const pending = sleep(60_000, controller.signal)
    controller.abort()
    await expect(pending).resolves.toBeUndefined()
    expect(Date.now() - start).toBeLessThan(1000)
  })

  it('已 abort 的 signal 直接返回', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sleep(60_000, controller.signal)).resolves.toBeUndefined()
  })

  it('无 signal 时按时长等待', async () => {
    const start = Date.now()
    await sleep(10)
    expect(Date.now() - start).toBeGreaterThanOrEqual(5)
  })
})
