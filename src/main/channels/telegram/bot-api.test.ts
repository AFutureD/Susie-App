import { afterEach, describe, expect, it, vi } from 'vitest'
import { BotApiError, callBotApi, getManagedBotToken } from './bot-api'

function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('callBotApi', () => {
  it('解包 ok 响应的 result', async () => {
    const fn = stubFetch({ ok: true, result: { id: 1, is_bot: true } })
    const result = await callBotApi<{ id: number }>('T:1', 'getMe')
    expect(result.id).toBe(1)
    expect(fn).toHaveBeenCalledWith('https://api.telegram.org/botT:1/getMe', expect.objectContaining({ method: 'POST' }))
  })

  it('SUSIE_TG_API_BASE 覆写 API base', async () => {
    vi.stubEnv('SUSIE_TG_API_BASE', 'http://127.0.0.1:8081')
    const fn = stubFetch({ ok: true, result: { id: 1, is_bot: true } })
    await callBotApi('T:1', 'getMe')
    expect(fn).toHaveBeenCalledWith('http://127.0.0.1:8081/botT:1/getMe', expect.anything())
  })

  it('非 ok 响应映射为 BotApiError（含 retry_after）', async () => {
    stubFetch({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } }, 429)
    const error = await callBotApi('T:1', 'getUpdates').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BotApiError)
    expect((error as BotApiError).code).toBe(429)
    expect((error as BotApiError).retryAfter).toBe(7)
  })

  it('非 JSON 响应映射为 BotApiError(HTTP status)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('gateway error', { status: 502 })))
    const error = await callBotApi('T:1', 'getMe').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BotApiError)
    expect((error as BotApiError).code).toBe(502)
  })

  it('外部 signal 中止时拒绝', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
      }),
    )
    const controller = new AbortController()
    const pending = callBotApi('T:1', 'getUpdates', {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow()
  })
})

describe('getManagedBotToken', () => {
  it('传 user_id 并归一 string 结果', async () => {
    const fn = stubFetch({ ok: true, result: '999:child-token' })
    await expect(getManagedBotToken('T:mgr', 999)).resolves.toBe('999:child-token')
    const body = JSON.parse((fn.mock.calls[0]?.[1] as RequestInit).body as string) as Record<string, unknown>
    expect(body['user_id']).toBe(999)
  })

  it('归一 { token } 包装结果；未知形状抛错', async () => {
    stubFetch({ ok: true, result: { token: '999:t' } })
    await expect(getManagedBotToken('T:mgr', 999)).resolves.toBe('999:t')

    stubFetch({ ok: true, result: { nope: 1 } })
    await expect(getManagedBotToken('T:mgr', 999)).rejects.toThrow('未知形状')
  })
})
