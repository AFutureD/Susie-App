import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { ZodError, type z } from 'zod'
import { errorMessage } from '../../shared/errors'
import { invokeChannel } from '../../shared/ipc/channel'
import {
  ipcContract,
  type ContractShape,
  type IpcContract,
  type MethodDef,
  type ResOf,
} from '../../shared/ipc/contract'
import { toErrorEnvelope } from '../../shared/ipc/envelope'
import type { Logger } from '../util/logger'

export interface IpcContext {
  event: IpcMainInvokeEvent
  sender: WebContents
}

/**
 * 主进程 handler 表：按契约逐 group/method 强制完整实现——
 * 缺一个 handler 或多一个未知键都是编译错误（配合 handlers/index.ts 的 satisfies）。
 * handler 收到的 payload 已过 zod 校验（z.output），异常统一转错误信封。
 */
export type IpcHandlers = {
  [G in keyof IpcContract]: {
    [M in keyof IpcContract[G]]: IpcContract[G][M] extends infer D extends MethodDef
      ? (payload: z.output<D['req']>, ctx: IpcContext) => ResOf<D> | Promise<ResOf<D>>
      : never
  }
}

/** 慢调用日志阈值：只记失败与慢调用，高频通道不刷屏 */
const SLOW_INVOKE_MS = 300

type AnyHandler = (payload: unknown, ctx: IpcContext) => unknown

/** 遍历契约注册全部 invoke handler。统一中间件：zod 校验 → 错误信封 → 慢调用日志。 */
export function registerIpcRouter(handlers: IpcHandlers, log: Logger, contract: ContractShape = ipcContract): void {
  const table = handlers as unknown as Record<string, Record<string, AnyHandler>>
  for (const [group, methods] of Object.entries(contract)) {
    for (const [method, def] of Object.entries(methods)) {
      const channel = invokeChannel(group, method)
      const handler = table[group]?.[method]
      if (handler === undefined) {
        // IpcHandlers 类型已在编译期挡住缺失；此分支只防「契约与 handler 表来源不一致」的运行时漂移
        throw new Error(`ipc handler 缺失：${channel}`)
      }
      ipcMain.handle(channel, async (event, raw: unknown) => {
        const start = performance.now()
        try {
          const payload: unknown = def.req.parse(raw)
          return await handler(payload, { event, sender: event.sender })
        } catch (error) {
          // ZodError.message 是 issues 的 JSON 串——取第一条 issue 作为可读文案
          const normalized =
            error instanceof ZodError ? new Error(error.issues[0]?.message ?? '入参不合法', { cause: error }) : error
          log.error(`ipc ${channel} 失败：${errorMessage(normalized)}`)
          return toErrorEnvelope(normalized)
        } finally {
          const elapsed = performance.now() - start
          if (elapsed > SLOW_INVOKE_MS) log.info(`ipc ${channel} 耗时 ${Math.round(elapsed)}ms`)
        }
      })
    }
  }
}
