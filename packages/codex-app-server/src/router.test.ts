import { describe, expect, it } from 'vitest'
import { TransportClosedError } from './errors'
import type { Notification } from './notifications'
import { MessageRouter } from './router'

function notification(method: string, params: Record<string, unknown>): Notification {
  return { method, params } as Notification
}

describe('MessageRouter', () => {
  it('routes responses to their request waiter', async () => {
    const router = new MessageRouter()
    const waiter = router.createResponseWaiter('req-1')
    router.routeResponse({ id: 'req-1', result: { ok: true } })
    await expect(waiter).resolves.toEqual({ ok: true })
  })

  it('maps JSON-RPC errors to typed exceptions', async () => {
    const router = new MessageRouter()
    const waiter = router.createResponseWaiter('req-2')
    router.routeResponse({ id: 'req-2', error: { code: -32601, message: 'nope' } })
    await expect(waiter).rejects.toMatchObject({ code: -32601 })
  })

  it('routes turn-scoped notifications by turnId and turn.id', async () => {
    const router = new MessageRouter()
    router.registerTurn('t1')
    router.routeNotification(notification('item/completed', { turnId: 't1', item: {} }))
    router.routeNotification(notification('turn/completed', { turn: { id: 't1', status: 'completed' } }))
    await expect(router.nextTurnNotification('t1')).resolves.toMatchObject({ method: 'item/completed' })
    await expect(router.nextTurnNotification('t1')).resolves.toMatchObject({ method: 'turn/completed' })
  })

  it('replays events buffered before the turn queue was registered', async () => {
    const router = new MessageRouter()
    router.routeNotification(notification('item/completed', { turnId: 't2', item: { early: true } }))
    router.registerTurn('t2')
    const first = await router.nextTurnNotification('t2')
    expect(first.params).toMatchObject({ item: { early: true } })
  })

  it('drops orphan turn/completed instead of buffering forever', () => {
    const router = new MessageRouter()
    router.routeNotification(notification('turn/completed', { turn: { id: 't3', status: 'completed' } }))
    router.registerTurn('t3')
    // 注册后不应重放已丢弃的完成事件——队列应为空（next 悬挂），用竞态验证
    let resolved = false
    void router.nextTurnNotification('t3').then(() => {
      resolved = true
    })
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(resolved).toBe(false)
        resolve(null)
      }, 20)
    })
  })

  it('routes non-turn notifications to the global queue', async () => {
    const router = new MessageRouter()
    router.routeNotification(notification('account/updated', { account: null }))
    await expect(router.nextGlobalNotification()).resolves.toMatchObject({ method: 'account/updated' })
  })

  it('failAll wakes every waiter with the transport error', async () => {
    const router = new MessageRouter()
    const waiter = router.createResponseWaiter('req-3')
    router.registerTurn('t4')
    const turnNext = router.nextTurnNotification('t4')
    router.failAll(new TransportClosedError('gone'))
    await expect(waiter).rejects.toBeInstanceOf(TransportClosedError)
    await expect(turnNext).rejects.toBeInstanceOf(TransportClosedError)
  })
})
