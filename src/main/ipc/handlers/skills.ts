import { shell } from 'electron'
import type { IpcHandlers } from '../router'
import type { ServiceHandlerDeps } from './channels'

export function skillsHandlers({ service }: ServiceHandlerDeps): IpcHandlers['skills'] {
  return {
    listLocal: (req) => service.skills.listLocal(req),
    listForAssistant: ({ id }) => service.skills.listForAssistant(id),
    remove: (req) => service.skills.remove(req),

    // reveal 留在 handler 层：manager 不引 electron，保持可单测
    reveal: async ({ path: target }) => {
      const failure = await shell.openPath(target)
      return failure === '' ? { ok: true } : { ok: false, message: failure }
    },

    listRepo: ({ source }) => service.skills.listRepo(source),
    installFromRepo: (req) => service.skills.installFromRepo(req),
  }
}
