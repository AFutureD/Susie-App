import { atom } from 'jotai'
import type { ChannelStatus } from '../../../shared/messages'

/** ChannelHub 状态镜像：channel:statuses 初始化，channel:status 事件保持同步 */
export const channelStatusesAtom = atom<ChannelStatus[]>([])

/** ManagedBotRegistry 状态镜像（manager bot 是渠道管理不是渠道，独立事件流） */
export const managerStatusesAtom = atom<ChannelStatus[]>([])
