import type { Message } from 'node-telegram-bot-api'
import { encodeChatId } from '../../../shared/chat-id'

// Telegram Topic 判定的单一入口。
// message 与 callback_query.message（可能退化为 InaccessibleMessage）共用同一个决策函数。
// 官方字段语义：
// - chat.is_forum：supergroup 是否开启 Topics（getMe.has_topics_enabled 只用于诊断，不参与判定）
// - message.is_topic_message：当前消息是否属于 Topic
// - message.message_thread_id：普通消息线程或 Topic 的标识，单独不能证明 Topic
// 规范式：私聊仅凭 is_topic_message + thread!=null && thread!=1 生成第三段；supergroup 还需 is_forum=true。

/** 判定所需的最小信号集（同时覆盖 Message 与 InaccessibleMessage） */
export interface TopicSignals {
  chatType: string
  rawChatId: number
  /** chat.is_forum；不可得时按 false 处理 */
  isForum: boolean
  /** message.is_topic_message；不可得（InaccessibleMessage）时按 false 处理 */
  isTopicMessage: boolean
  /** message.message_thread_id；不存在或不可得时为 null */
  threadId: number | null
}

export interface ResolvedChatId {
  /** canonical chat id：普通线程一律降为基础会话，仅真 Topic 保留第三段 */
  chatId: string
  /** true = 保留了第三段（真 Topic）；false = 归入基础会话 */
  isTopic: boolean
}

/**
 * 目标行为矩阵（详见 260728T1625-fix-telegram-topic-chat-id）：
 *
 * | 场景 | Telegram 信号 | canonical chat_id |
 * |---|---|---|
 * | 普通 supergroup 消息 | 无 Topic 信号 | S:<chat_id> |
 * | 普通 supergroup 线程 | 只有 message_thread_id | S:<chat_id> |
 * | Forum 非 General Topic | is_forum + is_topic_message + thread != 1 | S:<chat_id>:<topic_id> |
 * | Forum General Topic | 无 is_topic_message，即使带 thread | S:<chat_id> |
 * | 普通 bot 私聊 | 无 is_topic_message | P:<chat_id> |
 * | bot 私聊 Topic | is_topic_message + thread != 1 | P:<chat_id>:<topic_id> |
 * | Channel Direct Messages Topic | direct_messages_topic 语义独立 | 不生成 Forum Topic 后缀 |
 * | 信号矛盾/callback 不可得 | 无法证明属于 Topic | 基础 chat_id |
 */
export function resolveTelegramChatId(signals: TopicSignals): ResolvedChatId {
  const base = encodeChatId(signals.chatType, signals.rawChatId)
  if (base === '') return { chatId: '', isTopic: false }

  const { threadId, isTopicMessage, isForum, chatType } = signals

  // 无 thread：一律基础会话
  if (threadId === null) return { chatId: base, isTopic: false }
  // General Topic 的 thread id 恒为 1：即使带 thread 也不算独立 Topic
  if (threadId === 1) return { chatId: base, isTopic: false }
  // is_topic_message 是 Topic 的必要证据：仅有普通 thread id 不能证明 Topic
  if (!isTopicMessage) return { chatId: base, isTopic: false }
  // supergroup Topic 必须开 Forum；Channel Direct Messages Topic 语义独立，不生成 Forum 后缀
  if (chatType === 'supergroup') {
    if (!isForum) return { chatId: base, isTopic: false }
  } else if (chatType !== 'private') {
    return { chatId: base, isTopic: false }
  }

  return { chatId: encodeChatId(chatType, signals.rawChatId, threadId), isTopic: true }
}

/** 从入站 Message 抽取判定信号 */
export function signalsFromMessage(message: Message): TopicSignals {
  return {
    chatType: message.chat.type,
    rawChatId: message.chat.id,
    isForum: message.chat.is_forum ?? false,
    isTopicMessage: message.is_topic_message ?? false,
    threadId: message.message_thread_id ?? null,
  }
}

/**
 * 从 callback_query.message 抽取信号。48h 后回调里的 message 会退化为 InaccessibleMessage
 * （只保留 chat + message_id + date=0，缺 is_topic_message / message_thread_id），一律回退基础会话。
 */
export function signalsFromCallbackSource(source: unknown): TopicSignals | null {
  if (source === null || source === undefined || typeof source !== 'object') return null
  const record = source as {
    chat?: { id?: unknown; type?: unknown; is_forum?: unknown }
    is_topic_message?: unknown
    message_thread_id?: unknown
  }
  const chat = record.chat
  if (chat === undefined || typeof chat.id !== 'number' || typeof chat.type !== 'string') return null
  const threadRaw = record.message_thread_id
  return {
    chatType: chat.type,
    rawChatId: chat.id,
    isForum: chat.is_forum === true,
    isTopicMessage: record.is_topic_message === true,
    threadId: typeof threadRaw === 'number' && Number.isInteger(threadRaw) ? threadRaw : null,
  }
}
