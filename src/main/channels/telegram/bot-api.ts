// Telegram Bot API 的最小 raw 客户端（manager bot 专用）：
// node-telegram-bot-api v1.2 不认识 Bot API 9.6 的 managed_bot update，也没有 getManagedBotToken，
// manager 侧全部经此文件直调 HTTP。普通渠道（bot.ts）继续走库，互不影响。

import process from 'node:process'

/** API base 可经 SUSIE_TG_API_BASE 覆写（自建 Bot API server / e2e 本地 stub） */
const apiBase = (): string => process.env['SUSIE_TG_API_BASE'] ?? 'https://api.telegram.org'

export interface TgUser {
  id: number
  is_bot: boolean
  first_name?: string
  last_name?: string
  username?: string
  /** Bot API 9.6：getMe 返回，Bot Management Mode 开启标志 */
  can_manage_bots?: boolean
}

export interface TgChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  first_name?: string
  last_name?: string
  username?: string
}

export interface TgRawMessage {
  message_id: number
  date: number
  from?: TgUser
  chat: TgChat
  text?: string
  caption?: string
}

/** managed bot 被创建 / token 或 owner 变更；user = 操作者（创建者），bot = 被管 bot */
export interface TgManagedBotUpdated {
  user: TgUser
  bot: TgUser
}

export interface TgUpdate {
  update_id: number
  message?: TgRawMessage
  managed_bot?: TgManagedBotUpdated
}

/** TgUser 的显示名（对位 bot.ts displayName，但作用于 raw 形状） */
export function tgDisplayName(user: TgUser | undefined): string | null {
  if (user === undefined) return null
  const name = [user.first_name, user.last_name].filter((x) => x !== undefined && x !== '').join(' ')
  return name !== '' ? name : (user.username ?? String(user.id))
}

export class BotApiError extends Error {
  readonly code: number
  /** 429 时 Telegram 给出的等待秒数（parameters.retry_after） */
  readonly retryAfter: number | null

  constructor(code: number, description: string, retryAfter: number | null = null) {
    super(description)
    this.name = 'BotApiError'
    this.code = code
    this.retryAfter = retryAfter
  }
}

interface CallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

interface TgResponse {
  ok: boolean
  result?: unknown
  error_code?: number
  description?: string
  parameters?: { retry_after?: number }
}

export async function callBotApi<T>(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<T> {
  const { timeoutMs = 30_000, signal } = options
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]

  const response = await fetch(`${apiBase()}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.any(signals),
  })

  let payload: TgResponse
  try {
    payload = (await response.json()) as TgResponse
  } catch {
    throw new BotApiError(response.status, `HTTP ${response.status}（响应不是 JSON）`)
  }

  if (payload.ok !== true) {
    throw new BotApiError(
      payload.error_code ?? response.status,
      payload.description ?? `HTTP ${response.status}`,
      payload.parameters?.retry_after ?? null,
    )
  }
  return payload.result as T
}

export const getMeRaw = (token: string, signal?: AbortSignal): Promise<TgUser> =>
  callBotApi<TgUser>(token, 'getMe', {}, { timeoutMs: 15_000, signal })

/**
 * 取托管 bot 的 token。参数名 user_id 已真机确认（错误回报 "invalid user_id specified"）；
 * 非本 manager 托管的 bot → 400 BOT_ACCESS_FORBIDDEN。
 * 成功结果形状按 string / { token } 兼容归一（官方文档无样例）。
 */
export async function getManagedBotToken(
  managerToken: string,
  botUserId: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await callBotApi<string | { token?: string }>(
    managerToken,
    'getManagedBotToken',
    { user_id: botUserId },
    { timeoutMs: 15_000, signal },
  )
  const token = typeof result === 'string' ? result : result.token
  if (typeof token !== 'string' || token.length === 0) {
    throw new BotApiError(0, 'getManagedBotToken 返回了未知形状的结果')
  }
  return token
}
