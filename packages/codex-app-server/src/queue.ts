/** 无界异步队列：push 唤醒最早的 next()；fail 后所有等待者与后续 next() 均拒绝 */
export class AsyncQueue<T> {
  private readonly items: T[] = []
  private readonly waiters: { resolve: (item: T) => void; reject: (error: Error) => void }[] = []
  private failure: Error | null = null

  push(item: T): void {
    if (this.failure !== null) return
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter.resolve(item)
    else this.items.push(item)
  }

  fail(error: Error): void {
    if (this.failure !== null) return
    this.failure = error
    for (const waiter of this.waiters.splice(0)) waiter.reject(error)
  }

  next(): Promise<T> {
    const item = this.items.shift()
    if (item !== undefined) return Promise.resolve(item)
    if (this.failure !== null) return Promise.reject(this.failure)
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }
}
