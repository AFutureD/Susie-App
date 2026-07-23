// 消息路由（对位 openai_codex _message_router.py）：stdout 是单一有序流，
// 只有 reader 消费；每个在途请求 / 活跃 turn / 登录尝试各占一个队列，互不争抢。
import { CodexError, mapJsonRpcError } from './errors'
import type { JsonValue } from './generated/serde_json/JsonValue'
import { notificationLoginId, notificationTurnId, type JsonObject, type Notification } from './notifications'
import { AsyncQueue } from './queue'

interface ResponseWaiter {
  resolve: (result: JsonValue) => void
  reject: (error: Error) => void
}

export class MessageRouter {
  private readonly responseWaiters = new Map<string, ResponseWaiter>()
  private readonly loginQueues = new Map<string, AsyncQueue<Notification>>()
  private readonly pendingLogin = new Map<string, Notification[]>()
  private readonly turnQueues = new Map<string, AsyncQueue<Notification>>()
  private readonly pendingTurn = new Map<string, Notification[]>()
  private readonly globalQueue = new AsyncQueue<Notification>()

  createResponseWaiter(requestId: string): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      this.responseWaiters.set(requestId, { resolve, reject })
    })
  }

  discardResponseWaiter(requestId: string): void {
    this.responseWaiters.delete(requestId)
  }

  nextGlobalNotification(): Promise<Notification> {
    return this.globalQueue.next()
  }

  registerLogin(loginId: string): void {
    if (this.loginQueues.has(loginId)) return
    const queue = new AsyncQueue<Notification>()
    for (const notification of this.pendingLogin.get(loginId) ?? []) queue.push(notification)
    this.pendingLogin.delete(loginId)
    this.loginQueues.set(loginId, queue)
  }

  unregisterLogin(loginId: string): void {
    this.loginQueues.delete(loginId)
  }

  nextLoginNotification(loginId: string): Promise<Notification> {
    const queue = this.loginQueues.get(loginId)
    if (queue === undefined) return Promise.reject(new CodexError(`login ${loginId} 未注册通知队列`))
    return queue.next()
  }

  registerTurn(turnId: string): void {
    if (this.turnQueues.has(turnId)) return
    const queue = new AsyncQueue<Notification>()
    // turn/start 响应到达前事件可能已经开始流动：先入 pending，注册时重放
    for (const notification of this.pendingTurn.get(turnId) ?? []) queue.push(notification)
    this.pendingTurn.delete(turnId)
    this.turnQueues.set(turnId, queue)
  }

  unregisterTurn(turnId: string): void {
    this.turnQueues.delete(turnId)
  }

  nextTurnNotification(turnId: string): Promise<Notification> {
    const queue = this.turnQueues.get(turnId)
    if (queue === undefined) return Promise.reject(new CodexError(`turn ${turnId} 未注册通知队列`))
    return queue.next()
  }

  routeResponse(message: JsonObject): void {
    const waiter = this.responseWaiters.get(String(message['id']))
    if (waiter === undefined) return
    this.responseWaiters.delete(String(message['id']))

    const error = message['error']
    if (error !== undefined) {
      if (error !== null && typeof error === 'object' && !Array.isArray(error)) {
        const record = error as JsonObject
        waiter.reject(
          mapJsonRpcError(
            typeof record['code'] === 'number' ? record['code'] : -32000,
            String(record['message'] ?? 'unknown'),
            record['data'] ?? null,
          ),
        )
      } else {
        waiter.reject(new CodexError('JSON-RPC error 响应格式非法'))
      }
      return
    }
    waiter.resolve(message['result'] ?? null)
  }

  routeNotification(notification: Notification): void {
    const loginId = notificationLoginId(notification)
    if (loginId !== null) {
      const queue = this.loginQueues.get(loginId)
      if (queue === undefined) {
        const pending = this.pendingLogin.get(loginId) ?? []
        pending.push(notification)
        this.pendingLogin.set(loginId, pending)
        return
      }
      queue.push(notification)
      return
    }

    const turnId = notificationTurnId(notification)
    if (turnId === null) {
      this.globalQueue.push(notification)
      return
    }

    const queue = this.turnQueues.get(turnId)
    if (queue === undefined) {
      // 没有消费者的 turn/completed 直接丢弃 pending，避免泄漏
      if (notification.method === 'turn/completed') {
        this.pendingTurn.delete(turnId)
        return
      }
      const pending = this.pendingTurn.get(turnId) ?? []
      pending.push(notification)
      this.pendingTurn.set(turnId, pending)
      return
    }
    queue.push(notification)
  }

  /** reader 退出时唤醒所有阻塞等待者，避免任何调用永久挂起 */
  failAll(error: Error): void {
    for (const waiter of this.responseWaiters.values()) waiter.reject(error)
    this.responseWaiters.clear()
    for (const queue of this.loginQueues.values()) queue.fail(error)
    this.loginQueues.clear()
    this.pendingLogin.clear()
    for (const queue of this.turnQueues.values()) queue.fail(error)
    this.pendingTurn.clear()
    this.globalQueue.fail(error)
  }
}
