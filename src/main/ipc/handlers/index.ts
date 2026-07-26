// IPC handler 显式组装（不用 glob 自动装载：rolldown 无 import.meta.glob，
// 且 IpcHandlers 的完整性检查本身就是「忘了注册」的编译期报警器）。

import type { IpcHandlers } from '../router'
import { appHandlers, type AppHandlerDeps } from './app'

export type IpcHandlerDeps = AppHandlerDeps

export function buildIpcHandlers(deps: IpcHandlerDeps): IpcHandlers {
  return {
    app: appHandlers(deps),
  } satisfies IpcHandlers
}
