import { getMeRaw } from '../../channels/telegram/bot-api'
import { errorMessage } from '../../../shared/errors'
import type { SusieService } from '../../service'
import type { IpcHandlers } from '../router'

export interface ServiceHandlerDeps {
  service: SusieService
}

export function channelsHandlers({ service }: ServiceHandlerDeps): IpcHandlers['channels'] {
  return {
    statuses: () => service.hub.statuses(),

    identities: () => service.identity.identities(),

    resolveUsername: async ({ token }) => {
      try {
        const me = await getMeRaw(token.trim())
        if (me.username === undefined || me.username === '') {
          return { ok: false as const, message: 'bot 未返回 username' }
        }
        return { ok: true as const, username: me.username, canManageBots: me.can_manage_bots === true }
      } catch (error) {
        return { ok: false as const, message: errorMessage(error) }
      }
    },
  }
}

export function managerBotsHandlers({ service }: ServiceHandlerDeps): IpcHandlers['managerBots'] {
  return {
    statuses: () => service.managedBots.statuses(),
    // 弹窗打开时走带存活校验的版本（BotFather 已删的 bot 不列出）
    discoveries: ({ managerId }) => service.managedBots.listAddable(managerId),
    add: ({ managerId, botId, expectedVersion }) =>
      service.managedBots.addManagedBot({ managerId, botId, expectedVersion }),
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
