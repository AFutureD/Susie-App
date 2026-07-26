import type { IpcHandlers } from '../router'
import type { ServiceHandlerDeps } from './channels'

export function autoReviewHandlers({ service }: ServiceHandlerDeps): IpcHandlers['autoReview'] {
  return {
    list: ({ limit }) => service.autoReviewRepo.list(limit),
  }
}

export function historyHandlers({ service }: ServiceHandlerDeps): IpcHandlers['history'] {
  return {
    chats: () => service.messages.listChats(),

    senders: ({ channelId, chatId, privateOnly }) =>
      service.messages.listSenders(channelId, chatId, { privateOnly: privateOnly ?? false }),

    messages: ({ channelId, chatId, limit, beforeId }) =>
      service.messages.listMessages(channelId, chatId, {
        limit: limit ?? 80,
        ...(beforeId === undefined ? {} : { beforeId }),
      }),

    search: ({ q, limit }) => service.messages.search(q, limit ?? 50),
  }
}
