import { useState } from 'react'
import { useIntl } from 'react-intl'
import { decodeChatId } from '../../../../shared/chat-id'
import { CHAT_ALL } from '../../../../shared/config'
import type { ChatInfo } from '../../../../shared/messages'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'

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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[70vh] overflow-y-auto sm:max-w-96">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: 'bindings.picker.chat.title' }, { id: channelLabel ?? channelId })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {candidates.length === 0 && (
            <Empty>
              <EmptyDescription>{intl.formatMessage({ id: 'bindings.picker.chat.empty' })}</EmptyDescription>
            </Empty>
          )}
          {candidates.map((chat) => (
            <Button
              key={chat.chatId}
              variant="ghost"
              onClick={() => onPick(chat.chatId, chat.name)}
              className="h-auto w-full flex-col items-start px-2 py-1.5 text-left"
            >
              <span className="block truncate text-sm">{chat.name ?? chat.chatId}</span>
              <span className="block font-mono text-[11px] text-ink-muted">{chat.chatId}</span>
            </Button>
          ))}
        </div>
        <Separator />
        <Field>
          <FieldLabel htmlFor="chat-picker-manual">
            {intl.formatMessage({ id: 'bindings.picker.chat.manual' })}
          </FieldLabel>
          <Input
            id="chat-picker-manual"
            value={manual}
            placeholder="P:123456"
            onChange={(event) => setManual(event.target.value.trim())}
          />
        </Field>
        <DialogFooter>
          <Button disabled={!manualValid} onClick={() => onPick(manual, null)}>
            {intl.formatMessage({ id: 'bindings.picker.chat.confirm' })}
          </Button>
          <Button variant="outline" onClick={onClose}>
            {intl.formatMessage({ id: 'common.cancel' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
