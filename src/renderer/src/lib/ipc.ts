import { useEffect, useRef } from 'react'
import { eventChannel, invokeChannel } from '../../../shared/ipc/channel'
import type { IpcClient } from '../../../shared/ipc/contract'
import type { IpcEvents } from '../../../shared/ipc/events'

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

/** 订阅主进程事件（susie-evt:*）；返回退订函数 */
export function onIpcEvent<K extends keyof IpcEvents>(event: K, listener: (payload: IpcEvents[K]) => void): () => void {
  return window.susie.on(eventChannel(event), listener as (payload: unknown) => void)
}

/** React hook：handler 经 ref 转发（调用方无需 useCallback），组件卸载自动退订 */
export function useIpcEvent<K extends keyof IpcEvents>(event: K, handler: (payload: IpcEvents[K]) => void): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  useEffect(() => onIpcEvent(event, (payload) => handlerRef.current(payload)), [event])
}
