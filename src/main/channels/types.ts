import type { ChannelSettings } from '../../shared/config'
import type { ChannelStatus, ChatMessage, InboundEnvelope, MessagePart } from '../../shared/messages'
import type { ConfigRef } from '../config/store'
import type { CommandSpec } from '../core/commands'
import type { Logger } from '../util/logger'

// 通道抽象：core（approvals / chat-manager）只依赖本文件的接口，
// 平台细节（Telegram HTML 渲染、polling、命令菜单 scope 等）住在 channels/<平台>/ 里。
// 新增一种通道类型 = config union 加成员 + channels/<平台>/（实现 + factory）+ 组合根注册一行。

/** inline 按钮：id 直接作为回调载荷（Telegram callback_data 限 ≤64 字节，由调用方保证） */
export interface InlineButton {
  id: string
  label: string
}

/** inline 按钮点击事件（平台回调的领域化投影） */
export interface ChannelCallbackEvent {
  channelId: string
  /** 应答凭据（不应答则点按者客户端一直转圈；无此概念的平台传 ''） */
  callbackQueryId: string
  /** 点按者的平台用户 id（字符串形式，与 ChatMessage.senderId 同域） */
  fromId: string
  /** 回调载荷；缺失时为 '' */
  data: string
  /** 按钮所在会话/消息（不可得时为 null） */
  chatId: string | null
  messageId: string | null
}

export interface Channel {
  readonly id: string
  status(): ChannelStatus
  start(): Promise<void>
  stop(): Promise<void>
  sendMessage(message: ChatMessage, options?: { buttons?: InlineButton[][] }): Promise<ChatMessage>
  /** 尽力而为：编辑失败仅日志（Telegram 现实现即如此）；无编辑概念的平台实现为 no-op */
  editMessage(chatId: string, messageId: string, parts: MessagePart[], buttons: InlineButton[][] | null): Promise<void>
  /** 尽力而为：无回调应答概念的平台 no-op */
  answerCallback(callbackQueryId: string, text?: string): Promise<void>
  /** 与 userId 的私聊会话 id；平台无法构造时返回 null（Telegram：私聊 chat.id == user id） */
  directChatId(userId: string): string | null
  /** 输入中指示；返回停止函数 */
  beginTyping(chatId: string): () => void
  /** 平台命令菜单同步（无此概念的平台 no-op） */
  refreshCommandMenus(): Promise<void>
}

/** hub 注入给所有通道实现的公共依赖（平台无关） */
export interface ChannelCommonDeps {
  attachmentsDir: string
  /** 命令菜单名单，启动时注册 */
  listCommands: () => CommandSpec[]
  /** 可执行需审核命令的用户（owner + 私聊直通档）——其私聊注册完整命令菜单 */
  listPrivilegedUserIds: (channelId: string) => string[]
  onMessage: (envelope: InboundEnvelope) => void
  onCallback: (event: ChannelCallbackEvent) => void
  onStatus: (status: ChannelStatus) => void
  log: Logger
}

/** 通道工厂：type 与 config discriminated union 对齐，由组合根注册进 hub */
export interface ChannelFactory<S extends ChannelSettings = ChannelSettings> {
  readonly type: S['type']
  create(id: string, settingsRef: ConfigRef<S>, deps: ChannelCommonDeps): Channel
  /** 哪些字段变更需要重启实例；其余经 settingsRef 读穿即刻生效 */
  restartRequired(prev: S, next: S): boolean
}
