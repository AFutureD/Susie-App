import { errorMessage } from '../../../shared/errors'
import type { IpcHandlers } from '../router'
import type { ServiceHandlerDeps } from './channels'

// 暂依赖 SusieService 的 agent 门面方法；P6（AgentManager/Provider）落地后切换依赖。
export function agentsHandlers({ service }: ServiceHandlerDeps): IpcHandlers['agents'] {
  return {
    overview: () => service.agentsOverview(),
    models: ({ agentId }) => service.listAgentModels(agentId),

    install: async ({ id }) => {
      try {
        await service.installAgent(id)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },

    uninstall: ({ id }) => {
      try {
        service.uninstallAgent(id)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },
  }
}
