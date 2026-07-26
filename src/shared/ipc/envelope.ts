// IPC 错误信封：Electron 会把 handler 抛出的 Error 字符串化后在渲染端重建，
// cause 链、code 等结构化字段全部丢失。因此主进程 catch 后返回可结构化克隆的信封，
// preload 识别信封并还原成真 Error 再抛——调用方保持「失败即 reject」的契约。
// 本文件会被打进 preload（CJS sandbox），必须保持零依赖。

/** cause 链最大保留深度（防御恶意/意外的深层嵌套） */
const MAX_CAUSE_DEPTH = 5

export interface ErrorEnvelope {
  __susieIpcError__: true
  name: string
  message: string
  stack: string | undefined
  code: string | number | undefined
  cause: ErrorEnvelope | undefined
}

export function toErrorEnvelope(error: unknown, depth = 0): ErrorEnvelope {
  if (!(error instanceof Error)) {
    return {
      __susieIpcError__: true,
      name: 'Error',
      message: String(error),
      stack: undefined,
      code: undefined,
      cause: undefined,
    }
  }
  const code = (error as { code?: unknown }).code
  return {
    __susieIpcError__: true,
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: typeof code === 'string' || typeof code === 'number' ? code : undefined,
    cause: depth < MAX_CAUSE_DEPTH && error.cause !== undefined ? toErrorEnvelope(error.cause, depth + 1) : undefined,
  }
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return typeof value === 'object' && value !== null && (value as Record<string, unknown>)['__susieIpcError__'] === true
}

export function reviveError(envelope: ErrorEnvelope): Error {
  const error = new Error(envelope.message)
  error.name = envelope.name
  if (envelope.stack !== undefined) error.stack = envelope.stack
  if (envelope.code !== undefined) (error as Error & { code?: string | number }).code = envelope.code
  if (envelope.cause !== undefined) error.cause = reviveError(envelope.cause)
  return error
}
