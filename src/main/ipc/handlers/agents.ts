import { errorMessage } from '../../../shared/errors'
import type { IpcHandlers } from '../router'
import type { ServiceHandlerDeps } from './channels'

export function agentsHandlers({ service }: ServiceHandlerDeps): IpcHandlers['agents'] {
  return {
    overview: () => service.agents.overview(),
    models: ({ agentId }) => service.agents.listModels(agentId),

    install: async ({ id }) => {
      try {
        await service.agents.install(id)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },

    uninstall: ({ id }) => {
      try {
        service.agents.uninstall(id)
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },
  }
}
