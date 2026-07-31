// IPC handler 显式组装（不用 glob 自动装载：rolldown 无 import.meta.glob，
// 且 IpcHandlers 的完整性检查本身就是「忘了注册」的编译期报警器）。

import type { IpcHandlers } from '../router'
import { agentsHandlers } from './agents'
import { appHandlers, type AppHandlerDeps } from './app'
import { channelsHandlers, chatHandlers, managerBotsHandlers, type ServiceHandlerDeps } from './channels'
import { assistantsHandlers, configHandlers, type ConfigHandlerDeps } from './config'
import { autoReviewHandlers, historyHandlers } from './history'
import { skillsHandlers } from './skills'
import { logsHandlers, updateHandlers, type UpdaterHandlerDeps } from './system'
import { tasksHandlers } from './tasks'

export type IpcHandlerDeps = AppHandlerDeps & ConfigHandlerDeps & ServiceHandlerDeps & UpdaterHandlerDeps

export function buildIpcHandlers(deps: IpcHandlerDeps): IpcHandlers {
  return {
    app: appHandlers(deps),
    config: configHandlers(deps),
    assistants: assistantsHandlers(deps),
    channels: channelsHandlers(deps),
    managerBots: managerBotsHandlers(deps),
    chat: chatHandlers(deps),
    history: historyHandlers(deps),
    tasks: tasksHandlers(deps),
    agents: agentsHandlers(deps),
    skills: skillsHandlers(deps),
    logs: logsHandlers(),
    autoReview: autoReviewHandlers(deps),
    update: updateHandlers(deps),
  } satisfies IpcHandlers
}
