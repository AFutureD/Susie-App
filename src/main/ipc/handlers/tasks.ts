import type { IpcHandlers } from '../router'
import type { ServiceHandlerDeps } from './channels'

export function tasksHandlers({ service }: ServiceHandlerDeps): IpcHandlers['tasks'] {
  return {
    statuses: () => service.scheduler.statuses(),

    runs: ({ taskId, limit }) =>
      service.taskRuns.list({
        ...(taskId === undefined ? {} : { taskId }),
        ...(limit === undefined ? {} : { limit }),
      }),

    run: ({ id }) => service.scheduler.runNow(id),
  }
}
