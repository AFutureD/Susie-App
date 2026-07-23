// 过载重试助手（对位 openai_codex retry.py）：指数退避 + 抖动，仅重试瞬态过载错误
import { isRetryableError } from './errors'

export interface RetryOptions {
  maxAttempts?: number
  initialDelayMs?: number
  maxDelayMs?: number
  jitterRatio?: number
}

export async function retryOnOverload<T>(op: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3
  if (maxAttempts < 1) throw new Error('maxAttempts must be >= 1')
  const maxDelayMs = options.maxDelayMs ?? 2000
  const jitterRatio = options.jitterRatio ?? 0.2

  let delay = options.initialDelayMs ?? 250
  let attempt = 0
  for (;;) {
    attempt += 1
    try {
      return await op()
    } catch (error) {
      if (attempt >= maxAttempts || !isRetryableError(error)) throw error
      const jitter = delay * jitterRatio
      const sleepFor = Math.min(maxDelayMs, delay) + (Math.random() * 2 - 1) * jitter
      if (sleepFor > 0) await new Promise((resolve) => setTimeout(resolve, sleepFor))
      delay = Math.min(maxDelayMs, delay * 2)
    }
  }
}
