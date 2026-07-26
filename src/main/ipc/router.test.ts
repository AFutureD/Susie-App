import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ContractShape, ResType } from '../../shared/ipc/contract'
import { isErrorEnvelope, reviveError } from '../../shared/ipc/envelope'
import type { Logger } from '../util/logger'
import { registerIpcRouter, type IpcContext, type IpcHandlers } from './router'

const { registered } = vi.hoisted(() => ({
  registered: new Map<string, (event: unknown, raw: unknown) => Promise<unknown>>(),
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, raw: unknown) => Promise<unknown>) => {
      if (registered.has(channel)) throw new Error(`duplicate handler: ${channel}`)
      registered.set(channel, fn)
    },
  },
}))

const testContract = {
  echo: {
    say: { req: z.object({ text: z.string() }), res: {} as ResType<string> },
    boom: { req: z.void(), res: {} as ResType<string> },
    whoami: { req: z.void(), res: {} as ResType<string> },
  },
} as const satisfies ContractShape

function makeLog() {
  const errors: string[] = []
  const infos: string[] = []
  const log: Logger = { info: (message) => infos.push(message), error: (message) => errors.push(message) }
  return { log, errors, infos }
}

function setup() {
  registered.clear()
  const { log, errors, infos } = makeLog()
  const handlers = {
    echo: {
      say: ({ text }: { text: string }) => `said:${text}`,
      boom: () => {
        throw new Error('kaboom', { cause: new Error('root cause') })
      },
      whoami: (_payload: void, ctx: IpcContext) => `sender:${(ctx.sender as unknown as { id: string }).id}`,
    },
  } as unknown as IpcHandlers
  registerIpcRouter(handlers, log, testContract)
  return { errors, infos }
}

const fakeEvent = { sender: { id: 'wc-1' } }

describe('registerIpcRouter', () => {
  it('按契约注册全部通道并透传 payload 与 ctx', async () => {
    setup()
    expect([...registered.keys()].toSorted()).toEqual(['susie:echo.boom', 'susie:echo.say', 'susie:echo.whoami'])

    const say = registered.get('susie:echo.say')
    expect(await say?.(fakeEvent, { text: 'hi' })).toBe('said:hi')

    const whoami = registered.get('susie:echo.whoami')
    expect(await whoami?.(fakeEvent, undefined)).toBe('sender:wc-1')
  })

  it('zod 校验失败：返回错误信封并留错误日志', async () => {
    const { errors } = setup()
    const say = registered.get('susie:echo.say')

    const result = await say?.(fakeEvent, { text: 42 })
    expect(isErrorEnvelope(result)).toBe(true)
    expect(errors.some((line) => line.includes('susie:echo.say'))).toBe(true)
  })

  it('handler 抛错：转信封且保留 cause，preload 侧可还原', async () => {
    const { errors } = setup()
    const boom = registered.get('susie:echo.boom')

    const result = await boom?.(fakeEvent, undefined)
    expect(isErrorEnvelope(result)).toBe(true)
    if (!isErrorEnvelope(result)) throw new Error('expected envelope')
    const revived = reviveError(result)
    expect(revived.message).toBe('kaboom')
    expect((revived.cause as Error).message).toBe('root cause')
    expect(errors.some((line) => line.includes('kaboom'))).toBe(true)
  })

  it('契约键缺 handler：注册期直接抛（防契约与实现漂移）', () => {
    registered.clear()
    const { log } = makeLog()
    const incomplete = { echo: { say: () => 'x' } } as unknown as IpcHandlers
    expect(() => registerIpcRouter(incomplete, log, testContract)).toThrow('susie:echo.boom')
  })
})
