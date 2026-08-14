import { useState } from 'react'
import { useIntl } from 'react-intl'
import type { SenderInfo } from '../../../shared/messages'
import { ipc } from '../lib/ipc'
import { useIpcQuery } from '../lib/ipc-query'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'

// 选人通用件：「添加成员」滚动弹窗（搜索 + 发言候选 + 手动输入兜底）。
// UI 全程不显示 peer id（仅当手动添加且从无发言记录时以 id 兜底显示）。

/**
 * 会话/频道内出现过的发送者（chatId 省略 = 整个频道；privateOnly 仅私聊发送者）。
 * 订阅 history:message 实时刷新——新用户发言后立刻出现在候选列表。
 */
export function useSenders(channelId: string, chatId?: string, options: { privateOnly?: boolean } = {}): SenderInfo[] {
  const privateOnly = options.privateOnly === true
  const { data } = useIpcQuery(
    `history.senders:${channelId}:${chatId ?? ''}:${privateOnly ? 1 : 0}`,
    () =>
      ipc.history.senders({
        channelId,
        ...(chatId === undefined ? {} : { chatId }),
        ...(privateOnly ? { privateOnly: true } : {}),
      }),
    { invalidateOn: ['history.message'], enabled: channelId !== '' },
  )
  return data ?? []
}

/** 添加成员弹窗：点选即回调 onAdd 且保持打开（可连续添加）；已在 existing 中的候选不再出现 */
export function MemberPickerModal({
  channelId,
  chatId,
  existing,
  busy,
  onAdd,
  onClose,
}: {
  channelId: string
  /** 省略 = 整个频道的发言人 */
  chatId?: string
  existing: ReadonlySet<string>
  busy?: boolean
  onAdd: (id: string) => void
  onClose: () => void
}) {
  const intl = useIntl()
  const senders = useSenders(channelId, chatId)
  const [query, setQuery] = useState('')
  const [manual, setManual] = useState('')

  const candidates = senders.filter((sender) => !existing.has(sender.id))
  const needle = query.trim().toLowerCase()
  const filtered =
    needle === ''
      ? candidates
      : candidates.filter((sender) => (sender.name ?? sender.id).toLowerCase().includes(needle))
  const manualValid = /^\d+$/.test(manual) && !existing.has(manual)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[70vh] flex-col sm:max-w-96">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: 'members.addMember' })}</DialogTitle>
        </DialogHeader>
        <Input
          value={query}
          autoFocus
          placeholder={intl.formatMessage({ id: 'members.picker.search' })}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {candidates.length === 0 ? (
            <Empty>
              <EmptyDescription>{intl.formatMessage({ id: 'members.picker.empty' })}</EmptyDescription>
            </Empty>
          ) : filtered.length === 0 ? (
            <Empty>
              <EmptyDescription>{intl.formatMessage({ id: 'members.picker.noMatch' })}</EmptyDescription>
            </Empty>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filtered.map((sender) => (
                <Button
                  key={sender.id}
                  variant="ghost"
                  disabled={busy}
                  onClick={() => onAdd(sender.id)}
                  className="h-auto w-full justify-start px-2 py-1.5 text-left"
                >
                  {sender.name ?? sender.id}
                </Button>
              ))}
            </div>
          )}
        </div>
        <Separator />
        <Field>
          <FieldLabel htmlFor="member-picker-manual">{intl.formatMessage({ id: 'members.picker.manual' })}</FieldLabel>
          <Input
            id="member-picker-manual"
            value={manual}
            placeholder="123456789"
            onChange={(event) => setManual(event.target.value.trim())}
          />
        </Field>
        <DialogFooter>
          <Button
            disabled={busy === true || !manualValid}
            onClick={() => {
              onAdd(manual)
              setManual('')
            }}
          >
            {intl.formatMessage({ id: 'members.picker.add' })}
          </Button>
          <Button variant="outline" onClick={onClose}>
            {intl.formatMessage({ id: 'members.picker.done' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
