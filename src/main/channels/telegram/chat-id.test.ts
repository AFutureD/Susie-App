import { describe, expect, it } from 'vitest'
import { resolveTelegramChatId, signalsFromCallbackSource, signalsFromMessage, type TopicSignals } from './chat-id'

// 表驱动矩阵：与 260728T1625-fix-telegram-topic-chat-id/TASK.md 中的「目标行为」一一对应
const CASES: Array<{ name: string; signals: TopicSignals; expected: { chatId: string; isTopic: boolean } }> = [
  {
    name: '普通 supergroup 消息（无 thread）',
    signals: {
      chatType: 'supergroup',
      rawChatId: -1003778872743,
      isForum: false,
      isTopicMessage: false,
      threadId: null,
    },
    expected: { chatId: 'S:-1003778872743', isTopic: false },
  },
  {
    name: '普通 supergroup 线程（只有 thread id，无 Topic 信号）',
    signals: { chatType: 'supergroup', rawChatId: -1003778872743, isForum: false, isTopicMessage: false, threadId: 59 },
    expected: { chatId: 'S:-1003778872743', isTopic: false },
  },
  {
    name: 'Forum 非 General Topic',
    signals: { chatType: 'supergroup', rawChatId: -1001, isForum: true, isTopicMessage: true, threadId: 42 },
    expected: { chatId: 'S:-1001:42', isTopic: true },
  },
  {
    name: 'Forum General Topic（thread=1）保留 is_topic_message 也不算 Topic',
    signals: { chatType: 'supergroup', rawChatId: -1001, isForum: true, isTopicMessage: true, threadId: 1 },
    expected: { chatId: 'S:-1001', isTopic: false },
  },
  {
    name: 'Forum General Topic 携带无关 thread（is_topic_message=false）',
    signals: { chatType: 'supergroup', rawChatId: -1001, isForum: true, isTopicMessage: false, threadId: 99 },
    expected: { chatId: 'S:-1001', isTopic: false },
  },
  {
    name: 'Forum + is_topic_message 但 chat.is_forum 缺失（矛盾信号 → fallback）',
    signals: { chatType: 'supergroup', rawChatId: -1001, isForum: false, isTopicMessage: true, threadId: 42 },
    expected: { chatId: 'S:-1001', isTopic: false },
  },
  {
    name: '普通 bot 私聊',
    signals: { chatType: 'private', rawChatId: 12345, isForum: false, isTopicMessage: false, threadId: null },
    expected: { chatId: 'P:12345', isTopic: false },
  },
  {
    name: 'bot 私聊 Topic',
    signals: { chatType: 'private', rawChatId: 12345, isForum: false, isTopicMessage: true, threadId: 88 },
    expected: { chatId: 'P:12345:88', isTopic: true },
  },
  {
    name: 'bot 私聊 thread=1（对齐 General）',
    signals: { chatType: 'private', rawChatId: 12345, isForum: false, isTopicMessage: true, threadId: 1 },
    expected: { chatId: 'P:12345', isTopic: false },
  },
  {
    name: 'Channel Direct Messages Topic 语义独立，不生成 Forum Topic 后缀',
    signals: { chatType: 'channel', rawChatId: -100888, isForum: true, isTopicMessage: true, threadId: 5 },
    expected: { chatId: 'C:-100888', isTopic: false },
  },
  {
    name: '未知 chat 类型 → 空 chatId（上层按不支持处理）',
    signals: { chatType: 'unknown', rawChatId: 1, isForum: false, isTopicMessage: true, threadId: 42 },
    expected: { chatId: '', isTopic: false },
  },
]

describe('resolveTelegramChatId', () => {
  it.each(CASES)('$name', ({ signals, expected }) => {
    expect(resolveTelegramChatId(signals)).toEqual(expected)
  })
})

describe('signalsFromMessage', () => {
  it('reads chat.is_forum / is_topic_message / message_thread_id with defaults', () => {
    const message = {
      message_id: 100,
      date: 1,
      chat: { id: -1001, type: 'supergroup', is_forum: true },
      is_topic_message: true,
      message_thread_id: 42,
    } as unknown as import('node-telegram-bot-api').Message
    expect(signalsFromMessage(message)).toEqual({
      chatType: 'supergroup',
      rawChatId: -1001,
      isForum: true,
      isTopicMessage: true,
      threadId: 42,
    })
  })

  it('defaults absent Topic fields to false / null', () => {
    const message = {
      message_id: 100,
      date: 1,
      chat: { id: -1002, type: 'supergroup' },
    } as unknown as import('node-telegram-bot-api').Message
    expect(signalsFromMessage(message)).toEqual({
      chatType: 'supergroup',
      rawChatId: -1002,
      isForum: false,
      isTopicMessage: false,
      threadId: null,
    })
  })
})

describe('signalsFromCallbackSource', () => {
  it('parses a full Message payload from callback_query.message', () => {
    const source = {
      message_id: 5,
      date: 100,
      chat: { id: -1001, type: 'supergroup', is_forum: true },
      is_topic_message: true,
      message_thread_id: 42,
    }
    expect(signalsFromCallbackSource(source)).toEqual({
      chatType: 'supergroup',
      rawChatId: -1001,
      isForum: true,
      isTopicMessage: true,
      threadId: 42,
    })
  })

  it('handles InaccessibleMessage (date=0, no Topic fields) by falling back to base signals', () => {
    // 48h 后 Telegram 把 callback message 退化为 InaccessibleMessage：只保留 chat + message_id + date=0
    const source = { message_id: 5, date: 0, chat: { id: -1001, type: 'supergroup' } }
    const signals = signalsFromCallbackSource(source)
    expect(signals).toEqual({
      chatType: 'supergroup',
      rawChatId: -1001,
      isForum: false,
      isTopicMessage: false,
      threadId: null,
    })
    // 关键断言：InaccessibleMessage 一律回退基础会话
    expect(resolveTelegramChatId(signals!)).toEqual({ chatId: 'S:-1001', isTopic: false })
  })

  it('returns null when the source is missing or malformed', () => {
    expect(signalsFromCallbackSource(undefined)).toBeNull()
    expect(signalsFromCallbackSource(null)).toBeNull()
    expect(signalsFromCallbackSource({})).toBeNull()
    expect(signalsFromCallbackSource({ chat: { id: 'x', type: 'supergroup' } })).toBeNull()
  })
})
