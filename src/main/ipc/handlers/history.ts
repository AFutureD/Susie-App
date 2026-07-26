import type { IpcHandlers } from '../router'
import type { ServiceHandlerDeps } from './channels'

export function historyHandlers({ service }: ServiceHandlerDeps): IpcHandlers['history'] {
  return {
    chats: () => service.history.listChats(),

    senders: ({ channelId, chatId, privateOnly }) =>
      service.history.listSenders(channelId, chatId, { privateOnly: privateOnly ?? false }),

    messages: ({ channelId, chatId, limit, beforeId }) =>
      service.history.listMessages(channelId, chatId, {
        limit: limit ?? 80,
        ...(beforeId === undefined ? {} : { beforeId }),
      }),

    search: ({ q, limit }) => service.history.search(q, limit ?? 50),
  }
}
