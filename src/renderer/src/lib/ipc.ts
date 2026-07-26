import { invokeChannel } from '../../../shared/ipc/channel'
import type { IpcClient } from '../../../shared/ipc/contract'
import type { SusieBridge } from '../../../shared/ipc'

/** 旧泛型桥（逐域迁移期间保留；迁移完成后删除） */
export const susie: SusieBridge = window.susie

const groupCache = new Map<string, unknown>()

/**
 * 类型化 IPC 客户端：`ipc.app.getInfo()` → invoke('susie:app.getInfo')。
 * 两层 Proxy 运行时只拼通道字符串，契约仅作 type-only import——zod 不进 renderer bundle。
 * 主进程路由对异常返回错误信封，preload 已还原成真 Error，失败即 reject。
 */
export const ipc = new Proxy({} as IpcClient, {
  get(_target, group) {
    if (typeof group !== 'string') return undefined
    let cached = groupCache.get(group)
    if (cached === undefined) {
      cached = new Proxy(
        {},
        {
          get(_methods, method) {
            if (typeof method !== 'string') return undefined
            return (payload?: unknown) => window.susie.invoke(invokeChannel(group, method), payload)
          },
        },
      )
      groupCache.set(group, cached)
    }
    return cached
  },
})
