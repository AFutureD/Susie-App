import { CHAT_ALL, type TelegramBotChannelSettings } from '../../shared/config'

export interface InboundMeta {
  fromBot: boolean
  userId: string | null
  chatType: string
  rawChatId: string
  /** 群内消息是否 @ 了 bot 或回复了 bot */
  mentioned: boolean
}

function matchesWhitelist(whitelist: string[], userId: string): boolean {
  return whitelist.includes(CHAT_ALL) || whitelist.includes(userId)
}

/**
 * 入站准入（对位 Python TelegramBotChannel.is_message_allowed）。
 * 私聊：channel 级白名单；群聊：groups[chat_id] ?? groups["*"] 策略（only_mention + 白名单）。
 * settings 每次从 ConfigRef 读最新值——这些字段热更新即刻生效，无需重启通道。
 */
export function isInboundAllowed(settings: TelegramBotChannelSettings, meta: InboundMeta): boolean {
  if (meta.fromBot || meta.userId === null) return false

  if (meta.chatType === 'private') {
    return matchesWhitelist(settings.whitelist, meta.userId)
  }

  const policy = settings.groups[meta.rawChatId] ?? settings.groups[CHAT_ALL]
  if (policy === undefined) return false

  if (policy.only_mention && !meta.mentioned) return false

  return matchesWhitelist(policy.whitelist, meta.userId)
}
