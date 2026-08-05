import { expandBindings, type ChatAssignment, type WildcardAssignment } from '../../../../shared/bindings'
import { decodeChatId } from '../../../../shared/chat-id'
import type { Config } from '../../../../shared/config'
import type { ChatInfo } from '../../../../shared/messages'

// 树形导航的数据模型：准入统一由绑定决定，行集合 = 精确绑定的会话 + 本地草稿。

/** 刚添加的 chat 的乐观渲染占位（addChat 已同步落盘绑定，config 广播回流前由它撑住行与选中态） */
export interface DraftChat {
  channelId: string
  chatId: string
  name: string | null
}

export interface ChatRow {
  channelId: string
  /** 编码后的 chat id（P:…/G:…/S:…[:thread]） */
  chatId: string
  name: string | null
  /** private/group/supergroup/channel/sender；无法解析时为 null */
  chatType: string | null
  threadId: number | null
  /** 精确绑定的指派（含群触发属性）；null = 跟随频道默认 */
  assignment: ChatAssignment | null
}

export interface ChannelTree {
  channelId: string
  ghost: boolean
  /** 通道默认（chat_id='*'）的指派；null = 未设置（该通道其余会话不响应） */
  defaultAssignment: WildcardAssignment | null
  rows: ChatRow[]
}

export function buildTree(config: Config, chats: ChatInfo[], drafts: DraftChat[]): ChannelTree[] {
  const assignments = expandBindings(config.bindings)

  const names = new Map<string, string>()
  for (const chat of chats) {
    if (chat.name !== null) names.set(nameKey(chat.channelId, chat.chatId), chat.name)
  }
  for (const draft of drafts) {
    const key = nameKey(draft.channelId, draft.chatId)
    if (draft.name !== null && !names.has(key)) names.set(key, draft.name)
  }

  // 幽灵频道：绑定/草稿引用但配置中已不存在（显式呈现，不静默丢数据）
  const ghostIds = new Set<string>()
  for (const id of [...Object.keys(assignments.exact), ...Object.keys(assignments.wildcard)]) {
    if (!(id in config.channels)) ghostIds.add(id)
  }
  for (const draft of drafts) {
    if (!(draft.channelId in config.channels)) ghostIds.add(draft.channelId)
  }
  const channelIds = [...Object.keys(config.channels), ...[...ghostIds].toSorted()]

  return channelIds.map((channelId) => {
    const exact = assignments.exact[channelId] ?? {}

    const chatIds = new Set<string>(Object.keys(exact))
    for (const draft of drafts) {
      if (draft.channelId === channelId) chatIds.add(draft.chatId)
    }

    const rows: ChatRow[] = [...chatIds].toSorted().map((chatId) => {
      const decoded = decodeChatId(chatId)
      return {
        channelId,
        chatId,
        name: names.get(nameKey(channelId, chatId)) ?? null,
        chatType: decoded?.chatType ?? null,
        threadId: decoded?.threadId ?? null,
        assignment: exact[chatId] ?? null,
      }
    })

    return {
      channelId,
      ghost: ghostIds.has(channelId),
      defaultAssignment: assignments.wildcard[channelId] ?? null,
      rows,
    }
  })
}

function nameKey(channelId: string, chatId: string): string {
  return `${channelId}\n${chatId}`
}
