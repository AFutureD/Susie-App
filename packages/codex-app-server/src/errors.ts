// 错误层级（对位 openai_codex errors.py）：JSON-RPC 标准错误码映射到具体类，
// -32000..-32099 段按 payload 里的 server_overloaded 标记细分出可重试错误。
import type { JsonValue } from './generated/serde_json/JsonValue'

export class CodexError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

export class TransportClosedError extends CodexError {}

export class JsonRpcError extends CodexError {
  readonly code: number
  readonly data: JsonValue | undefined

  constructor(code: number, message: string, data?: JsonValue) {
    super(`JSON-RPC error ${code}: ${message}`)
    this.code = code
    this.data = data
  }
}

export class CodexRpcError extends JsonRpcError {}
export class ParseError extends CodexRpcError {}
export class InvalidRequestError extends CodexRpcError {}
export class MethodNotFoundError extends CodexRpcError {}
export class InvalidParamsError extends CodexRpcError {}
export class InternalRpcError extends CodexRpcError {}
export class ServerBusyError extends CodexRpcError {}
export class RetryLimitExceededError extends ServerBusyError {}

function containsRetryLimitText(message: string): boolean {
  const lowered = message.toLowerCase()
  return lowered.includes('retry limit') || lowered.includes('too many failed attempts')
}

function isServerOverloaded(data: JsonValue | undefined): boolean {
  if (data === undefined || data === null) return false
  if (typeof data === 'string') return data.toLowerCase() === 'server_overloaded'
  if (Array.isArray(data)) return data.some((value) => isServerOverloaded(value))
  if (typeof data === 'object') {
    const record = data as Record<string, JsonValue | undefined>
    const direct = record['codex_error_info'] ?? record['codexErrorInfo'] ?? record['errorInfo']
    if (typeof direct === 'string' && direct.toLowerCase() === 'server_overloaded') return true
    if (direct !== null && typeof direct === 'object' && !Array.isArray(direct)) {
      for (const value of Object.values(direct)) {
        if (typeof value === 'string' && value.toLowerCase() === 'server_overloaded') return true
      }
    }
    return Object.values(record).some((value) => isServerOverloaded(value))
  }
  return false
}

export function mapJsonRpcError(code: number, message: string, data?: JsonValue): JsonRpcError {
  if (code === -32700) return new ParseError(code, message, data)
  if (code === -32600) return new InvalidRequestError(code, message, data)
  if (code === -32601) return new MethodNotFoundError(code, message, data)
  if (code === -32602) return new InvalidParamsError(code, message, data)
  if (code === -32603) return new InternalRpcError(code, message, data)

  if (code >= -32099 && code <= -32000) {
    if (isServerOverloaded(data)) {
      if (containsRetryLimitText(message)) return new RetryLimitExceededError(code, message, data)
      return new ServerBusyError(code, message, data)
    }
    if (containsRetryLimitText(message)) return new RetryLimitExceededError(code, message, data)
    return new CodexRpcError(code, message, data)
  }
  return new JsonRpcError(code, message, data)
}

/** 瞬态过载类错误（调用方可重试） */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof ServerBusyError) return true
  if (error instanceof JsonRpcError) return isServerOverloaded(error.data)
  return false
}
