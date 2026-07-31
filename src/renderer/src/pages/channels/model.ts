import type { ChannelSettings, Config } from '../../../../shared/config'

// 渠道页的分组纯函数：managing 关系由 manager 侧持有（config.manager_bots[id].managing）。
// 存在的渠道进对应 manager 分组；幽灵引用（渠道已删）忽略；重复认领先声明者赢。

export interface ChannelEntry {
  id: string
  settings: ChannelSettings
}

export interface ChannelListModel {
  /** 顶层渠道（未被任何 manager 认领） */
  top: ChannelEntry[]
  /** managerId → 其托管的渠道（保持 managing 声明序） */
  grouped: Map<string, ChannelEntry[]>
}

export function buildChannelList(
  channels: Record<string, ChannelSettings>,
  managerBots: Config['manager_bots'],
): ChannelListModel {
  const grouped = new Map<string, ChannelEntry[]>()
  const claimed = new Set<string>()
  for (const [managerId, manager] of Object.entries(managerBots)) {
    const members: ChannelEntry[] = []
    for (const channelId of manager.managing) {
      const settings = channels[channelId]
      if (settings === undefined || claimed.has(channelId)) continue
      claimed.add(channelId)
      members.push({ id: channelId, settings })
    }
    grouped.set(managerId, members)
  }
  const top = Object.entries(channels)
    .filter(([id]) => !claimed.has(id))
    .map(([id, settings]) => ({ id, settings }))
  return { top, grouped }
}
