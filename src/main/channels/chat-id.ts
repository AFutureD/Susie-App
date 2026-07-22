// chat_id 编码沿用 Python 版方案：<前缀>:<raw_chat_id>[:<thread_id>]
// P=private G=group S=supergroup C=channel X=sender

const KIND_TO_PREFIX: Record<string, string> = {
  private: 'P',
  group: 'G',
  supergroup: 'S',
  channel: 'C',
  sender: 'X',
}

const PREFIX_TO_KIND: Record<string, string> = Object.fromEntries(
  Object.entries(KIND_TO_PREFIX).map(([kind, prefix]) => [prefix, kind]),
)

export function encodeChatId(chatType: string, rawChatId: number | string, threadId?: number | null): string {
  const prefix = KIND_TO_PREFIX[chatType]
  if (prefix === undefined) return ''
  return threadId === undefined || threadId === null ? `${prefix}:${rawChatId}` : `${prefix}:${rawChatId}:${threadId}`
}

export interface DecodedChatId {
  chatType: string
  rawChatId: number
  threadId: number | null
}

export function decodeChatId(chatId: string): DecodedChatId | null {
  const parts = chatId.split(':')
  if (parts.length !== 2 && parts.length !== 3) return null

  const prefix = parts[0]?.toUpperCase() ?? ''
  const chatType = PREFIX_TO_KIND[prefix]
  if (chatType === undefined) return null

  const rawChatId = Number(parts[1])
  if (!Number.isInteger(rawChatId)) return null

  if (parts.length === 3) {
    const threadId = Number(parts[2])
    if (!Number.isInteger(threadId)) return null
    return { chatType, rawChatId, threadId }
  }
  return { chatType, rawChatId, threadId: null }
}
