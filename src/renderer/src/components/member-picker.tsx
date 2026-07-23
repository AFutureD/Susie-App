import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import type { SenderInfo } from '../../../shared/messages'
import { susie } from '../lib/ipc'
import { Button, Field, TextInput } from './form'

// 成员白名单的通用件：昵称芯片列表 + 「添加成员」滚动弹窗（搜索 + 发言候选 + 手动输入兜底）。
// UI 全程不显示 peer id（仅当手动添加且从无发言记录时以 id 兜底显示）。

/** 会话/频道内出现过的发送者（chatId 省略 = 整个频道） */
export function useSenders(channelId: string, chatId?: string): SenderInfo[] {
  const [senders, setSenders] = useState<SenderInfo[]>([])
  useEffect(() => {
    if (channelId === '') {
      setSenders([])
      return
    }
    let alive = true
    const payload = chatId === undefined ? { channelId } : { channelId, chatId }
    void susie.invoke('history:senders', payload).then((list) => {
      if (alive) setSenders(list)
    })
    return () => {
      alive = false
    }
  }, [channelId, chatId])
  return senders
}

/** 已选成员芯片（限高滚动）；members 为空时显示 emptyText */
export function MemberChips({
  members,
  nameOf,
  emptyText,
  disabled,
  onRemove,
}: {
  members: string[]
  nameOf: (id: string) => string
  emptyText: string
  disabled?: boolean
  onRemove: (id: string) => void
}) {
  const intl = useIntl()
  if (members.length === 0) {
    return <p className="text-sm text-ink-muted">{emptyText}</p>
  }
  return (
    <div className="flex max-h-28 flex-wrap content-start gap-1.5 overflow-y-auto">
      {members.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"
        >
          {nameOf(id)}
          <button
            type="button"
            disabled={disabled}
            aria-label={intl.formatMessage({ id: 'members.remove' }, { name: nameOf(id) })}
            onClick={() => onRemove(id)}
            className="rounded-full px-0.5 transition-colors hover:bg-accent/20 disabled:opacity-40"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="flex max-h-[70vh] w-96 flex-col rounded-xl border border-line bg-raised p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold">{intl.formatMessage({ id: 'members.addMember' })}</h3>
        <TextInput
          value={query}
          autoFocus
          placeholder={intl.formatMessage({ id: 'members.picker.search' })}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
          {candidates.length === 0 ? (
            <p className="py-2 text-xs text-ink-muted">{intl.formatMessage({ id: 'members.picker.empty' })}</p>
          ) : filtered.length === 0 ? (
            <p className="py-2 text-xs text-ink-muted">{intl.formatMessage({ id: 'members.picker.noMatch' })}</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {filtered.map((sender) => (
                <button
                  key={sender.id}
                  type="button"
                  disabled={busy}
                  onClick={() => onAdd(sender.id)}
                  className="rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-line/40 disabled:opacity-40"
                >
                  {sender.name ?? sender.id}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="mt-3 border-t border-line pt-3">
          <Field label={intl.formatMessage({ id: 'members.picker.manual' })}>
            <TextInput
              value={manual}
              placeholder="123456789"
              onChange={(event) => setManual(event.target.value.trim())}
            />
          </Field>
          <div className="mt-3 flex gap-2">
            <Button
              variant="primary"
              disabled={busy === true || !manualValid}
              onClick={() => {
                onAdd(manual)
                setManual('')
              }}
            >
              {intl.formatMessage({ id: 'members.picker.add' })}
            </Button>
            <Button onClick={onClose}>{intl.formatMessage({ id: 'members.picker.done' })}</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
