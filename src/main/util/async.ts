/** 给任意 promise 加硬超时；超时返回 fallback（不抛异常，用于停机等必须前进的路径） */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 超时抛错版本（用于启动探测等应报错的路径） */
export async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 可中断睡眠：abort 立即 resolve（不 reject）；signal 缺省则纯 setTimeout */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) {
      setTimeout(resolve, ms)
      return
    }
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    if (signal.aborted) finish()
    else signal.addEventListener('abort', finish, { once: true })
  })
}

/** 串行闸门：acquire() 排队取锁，返回 release（ACP turn 串行与 Codex steer-or-start 判定的公共形态） */
export class SerialGate {
  private tail: Promise<void> = Promise.resolve()

  async acquire(): Promise<() => void> {
    const previous = this.tail
    let release: () => void = () => {}
    this.tail = new Promise((resolve) => {
      release = resolve
    })
    await previous
    return release
  }
}

interface ExitWaitable {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  once(event: 'exit', listener: () => void): unknown
  off(event: 'exit', listener: () => void): unknown
}

/** 等子进程退出；超时返回 false（调用方决定是否升级 SIGKILL）。已退出的进程立即返回 true。 */
export function waitChildExit(child: ExitWaitable, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      resolve(false)
    }, ms)
    child.once('exit', onExit)
  })
}
