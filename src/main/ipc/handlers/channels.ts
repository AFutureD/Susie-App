import { fetchBotUsername } from '../../channels/telegram-bot'
import { errorMessage } from '../../../shared/errors'
import type { SusieService } from '../../service'
import type { IpcHandlers } from '../router'

export interface ServiceHandlerDeps {
  service: SusieService
}

export function channelsHandlers({ service }: ServiceHandlerDeps): IpcHandlers['channels'] {
  return {
    statuses: () => service.hub.statuses(),

    resolveUsername: async ({ token }) => {
      try {
        return { ok: true as const, username: await fetchBotUsername(token) }
      } catch (error) {
        return { ok: false as const, message: errorMessage(error) }
      }
    },
  }
}

export function chatHandlers({ service }: ServiceHandlerDeps): IpcHandlers['chat'] {
  return {
    send: async ({ channelId, chatId, text }) => {
      try {
        await service.chatManager.sendMessage({ channelId, chatId, parts: [{ kind: 'text', text }] })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },
  }
}
