import { describe, expect, it } from 'vitest'
import { Backoff } from './backoff'

describe('Backoff', () => {
  it('指数递增封顶，reset 归位', () => {
    const backoff = new Backoff(100, 400)
    expect([backoff.next(), backoff.next(), backoff.next(), backoff.next()]).toEqual([100, 200, 400, 400])
    backoff.reset()
    expect(backoff.next()).toBe(100)
  })
})
