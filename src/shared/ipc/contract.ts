// 主进程 ↔ 渲染进程的 IPC 契约（唯一事实源）。
// - req 用 zod schema：主进程路由（main/ipc/router.ts）对每个通道做运行时校验；
// - res 用 phantom token：响应来自可信主进程，只承载类型不做运行时校验；
// - 通道名由 group + method 自动派生（susie:<group>.<method>），主进程 handler 的完整性由
//   IpcHandlers 映射类型强制（缺一个 = 编译错），preload 只做前缀门卫——不存在第三份手工清单。
// 渲染端经 type-only import 取 IpcClient 类型，zod 不进 renderer bundle。

import { z } from 'zod'

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  headless: boolean
  loginItemEnabled: boolean
  mcpUrl: string | null
}

export type ActionResult = { ok: true } | { ok: false; message: string }

/** res 类型占位：运行时是共享冻结空对象（零成本），类型经 ResOf 提取 */
const RES_TOKEN = Object.freeze({})
export interface ResType<T> {
  readonly __res?: T
}
const res = <T>(): ResType<T> => RES_TOKEN as ResType<T>

export interface MethodDef {
  req: z.ZodType
  res: ResType<unknown>
}
export type ContractShape = Record<string, Record<string, MethodDef>>

export const ipcContract = {
  app: {
    getInfo: { req: z.void(), res: res<AppInfo>() },
    setLoginItem: { req: z.object({ enabled: z.boolean() }), res: res<ActionResult>() },
    /** 在系统默认浏览器/对应 App 打开外部链接（仅 https） */
    openExternal: { req: z.object({ url: z.string() }), res: res<ActionResult>() },
    pickDirectory: { req: z.void(), res: res<string | null>() },
  },
} as const satisfies ContractShape

export type IpcContract = typeof ipcContract

export type ResOf<D extends MethodDef> = D['res'] extends ResType<infer T> ? T : never

/**
 * 渲染端客户端类型：入参用 z.input（带 default 的字段可省略），返回 Promise<res>。
 * req 为 z.void() 的方法调用时不带参数。
 */
export type IpcClient = {
  [G in keyof IpcContract]: {
    [M in keyof IpcContract[G]]: IpcContract[G][M] extends infer D extends MethodDef
      ? [z.input<D['req']>] extends [void]
        ? () => Promise<ResOf<D>>
        : (payload: z.input<D['req']>) => Promise<ResOf<D>>
      : never
  }
}
