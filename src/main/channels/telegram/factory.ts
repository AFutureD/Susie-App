import type { TelegramBotChannelSettings } from '../../../shared/config'
import type { ConfigRef } from '../../config/store'
import type { Channel, ChannelCommonDeps, ChannelFactory } from '../types'
import { TelegramBotChannel } from './bot'

export const telegramBotFactory: ChannelFactory<TelegramBotChannelSettings> = {
  type: 'telegram_bot',

  create(id: string, settingsRef: ConfigRef<TelegramBotChannelSettings>, deps: ChannelCommonDeps): Channel {
    return new TelegramBotChannel({
      id,
      settingsRef,
      attachmentsDir: deps.attachmentsDir,
      listCommands: deps.listCommands,
      listPrivilegedUserIds: () => deps.listPrivilegedUserIds(id),
      onMessage: deps.onMessage,
      onCallback: deps.onCallback,
      onStatus: deps.onStatus,
      log: deps.log,
    })
  },

  /** 需要重启通道的字段；其余字段（白名单/群策略等）经 ConfigRef 读穿即刻生效 */
  restartRequired(prev, next) {
    return prev.token !== next.token || prev.drop_pending_updates !== next.drop_pending_updates
  },
}
