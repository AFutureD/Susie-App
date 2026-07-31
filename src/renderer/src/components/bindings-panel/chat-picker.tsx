import { useState } from 'react'
import { useIntl } from 'react-intl'
import { decodeChatId } from '../../../../shared/chat-id'
import { CHAT_ALL } from '../../../../shared/config'
import type { ChatInfo } from '../../../../shared/messages'
import { Button, Field, TextInput } from '../form'
import { Modal } from '../modal'

/** 添加会话弹窗：历史会话候选 + 手动输入兜底 */
export function ChatPickerModal({
  channelId,
  channelLabel,
  chats,
  existingChatIds,
  excludeChatTypes,
  onPick,
  onClose,
}: {
  channelId: string
  /** 标题里的渠道显示名；缺省用 channelId */
  channelLabel?: string
  chats: ChatInfo[]
  existingChatIds: Set<string>
  /** 屏蔽的 chat 类型（如 bindings 侧屏蔽 'channel'；定时任务不设，允许全部类型） */
  excludeChatTypes?: readonly string[]
  onPick: (chatId: string, name: string | null) => void
  onClose: () => void
}) {
  const intl = useIntl()
  const [manual, setManual] = useState('')

  const isExcluded = (chatId: string): boolean => {
    if (excludeChatTypes === undefined || excludeChatTypes.length === 0) return false
    const kind = decodeChatId(chatId)?.chatType
    return kind !== undefined && excludeChatTypes.includes(kind)
  }
  const candidates = chats.filter(
    (chat) => chat.channelId === channelId && !existingChatIds.has(chat.chatId) && !isExcluded(chat.chatId),
  )
  // '*' 是数据层保留字（通道默认由「默认」行表达），空白会破坏 chat key 编码
  const manualValid = /^\S+$/.test(manual) && manual !== CHAT_ALL && !existingChatIds.has(manual) && !isExcluded(manual)

  return (
    <Modal
      title={intl.formatMessage({ id: 'bindings.picker.chat.title' }, { id: channelLabel ?? channelId })}
      panelClassName="max-h-[70vh] w-96 overflow-y-auto p-4"
      onClose={onClose}
    >
      <div className="flex flex-col gap-1">
        {candidates.length === 0 && (
          <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'bindings.picker.chat.empty' })}</p>
        )}
        {candidates.map((chat) => (
          <button
            key={chat.chatId}
            type="button"
            onClick={() => onPick(chat.chatId, chat.name)}
            className="rounded-md px-2 py-1.5 text-left transition-colors hover:bg-line/40"
          >
            <span className="block truncate text-sm">{chat.name ?? chat.chatId}</span>
            <span className="block font-mono text-[11px] text-ink-muted">{chat.chatId}</span>
          </button>
        ))}
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <Field label={intl.formatMessage({ id: 'bindings.picker.chat.manual' })}>
          <TextInput value={manual} placeholder="P:123456" onChange={(event) => setManual(event.target.value.trim())} />
        </Field>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" disabled={!manualValid} onClick={() => onPick(manual, null)}>
            {intl.formatMessage({ id: 'bindings.picker.chat.confirm' })}
          </Button>
          <Button onClick={onClose}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
        </div>
      </div>
    </Modal>
  )
}
