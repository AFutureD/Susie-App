// IPC handler 显式组装（不用 glob 自动装载：rolldown 无 import.meta.glob，
// 且 IpcHandlers 的完整性检查本身就是「忘了注册」的编译期报警器）。

import type { IpcHandlers } from '../router'
import { appHandlers, type AppHandlerDeps } from './app'
import { channelsHandlers, chatHandlers, type ServiceHandlerDeps } from './channels'
import { assistantsHandlers, configHandlers, type ConfigHandlerDeps } from './config'
import { historyHandlers } from './history'

export type IpcHandlerDeps = AppHandlerDeps & ConfigHandlerDeps & ServiceHandlerDeps

export function buildIpcHandlers(deps: IpcHandlerDeps): IpcHandlers {
  return {
    app: appHandlers(deps),
    config: configHandlers(deps),
    assistants: assistantsHandlers(deps),
    channels: channelsHandlers(deps),
    chat: chatHandlers(deps),
    history: historyHandlers(deps),
  } satisfies IpcHandlers
}
