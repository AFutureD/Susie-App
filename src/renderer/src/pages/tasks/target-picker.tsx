import { useState } from 'react'
import { useIntl } from 'react-intl'
import { decodeChatId } from '../../../../shared/chat-id'
import type { TaskTarget } from '../../../../shared/config'
import type { ChatInfo } from '../../../../shared/messages'
import { ChatPickerModal } from '../../components/bindings-panel/chat-picker'
import { Button, Select } from '../../components/form'

// 投递目标：已选列表 + 「添加会话」弹窗（复用会话绑定的 ChatPickerModal：
// 历史会话候选 + 手动输入兜底），私聊/群聊混选、可跨频道。

export function TargetPicker({
  channelIds,
  chats,
  targets,
  onChange,
}: {
  /** 已配置的频道 id（添加候选） */
  channelIds: string[]
  chats: ChatInfo[]
  targets: TaskTarget[]
  onChange: (targets: TaskTarget[]) => void
}) {
  const intl = useIntl()
  const [channel, setChannel] = useState('')
  /** 非 null = 弹窗打开，值为目标频道 */
  const [picking, setPicking] = useState<string | null>(null)

  const effectiveChannel = channel !== '' ? channel : (channelIds[0] ?? '')

  const remove = (target: TaskTarget): void => {
    onChange(targets.filter((item) => !(item.channel === target.channel && item.chat_id === target.chat_id)))
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-surface px-3 py-2.5">
      {targets.length === 0 && (
        <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'tasks.targets.empty' })}</p>
      )}
      {targets.map((target) => {
        const chat = chats.find((item) => item.channelId === target.channel && item.chatId === target.chat_id)
        return (
          <div key={`${target.channel} ${target.chat_id}`} className="flex items-center gap-2">
            <span className="shrink-0 rounded bg-line/50 px-1 py-px font-mono text-[11px] text-ink-muted">
              {target.channel}
            </span>
            <span className="truncate text-sm">{chat?.name ?? target.chat_id}</span>
            <ChatTypeTag chatId={target.chat_id} />
            <span className="ml-auto shrink-0 font-mono text-[11px] text-ink-muted">{target.chat_id}</span>
            <Button className="px-2 py-0.5 text-xs" onClick={() => remove(target)}>
              {intl.formatMessage({ id: 'tasks.targets.remove' })}
            </Button>
          </div>
        )
      })}

      <div className="flex items-center gap-1.5 border-t border-line pt-2.5">
        {channelIds.length === 0 ? (
          <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'tasks.targets.noChannel' })}</p>
        ) : (
          <>
            {channelIds.length > 1 && (
              // Select 自带 w-full，用容器限宽
              <div className="w-36 shrink-0">
                <Select value={effectiveChannel} onChange={(event) => setChannel(event.target.value)}>
                  {channelIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <Button onClick={() => setPicking(effectiveChannel)}>
              {intl.formatMessage({ id: 'tasks.targets.addChat' })}
            </Button>
          </>
        )}
      </div>

      {picking !== null && (
        <ChatPickerModal
          channelId={picking}
          chats={chats}
          existingChatIds={
            new Set(targets.filter((target) => target.channel === picking).map((target) => target.chat_id))
          }
          onPick={(chatId) => {
            onChange([...targets, { channel: picking, chat_id: chatId }])
            setPicking(null)
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  )
}

function ChatTypeTag({ chatId }: { chatId: string }) {
  const intl = useIntl()
  const kind = decodeChatId(chatId)?.chatType
  const id =
    kind === 'private'
      ? 'tasks.targets.type.private'
      : kind === 'group' || kind === 'supergroup'
        ? 'tasks.targets.type.group'
        : kind === 'channel'
          ? 'tasks.targets.type.channel'
          : null
  if (id === null) return null
  return (
    <span className="shrink-0 rounded bg-line/50 px-1 py-px text-[11px] text-ink-muted">
      {intl.formatMessage({ id })}
    </span>
  )
}
