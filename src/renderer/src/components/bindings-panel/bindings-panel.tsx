import { useCallback, useEffect, useMemo, useState } from 'react'
import { useIntl } from 'react-intl'
import {
  canonicalizeBindings,
  expandBindings,
  type BindingAssignments,
  type ChatAssignment,
} from '../../../../shared/bindings'
import { CHAT_ALL, type ConfigState } from '../../../../shared/config'
import type { ChatInfo } from '../../../../shared/messages'
import { ipc, susie } from '../../lib/ipc'
import { Button, CheckboxField, ErrorText, Field, Select, TextInput } from '../form'
import { buildTree, type ChannelTree, type ChatRow, type DraftChat } from './model'

// 两栏主从式：左栏 channel → chat 树形导航，右栏为选中会话的配置。
// 绑定 = 路由：会话 → 助手 + 触发/输出配置；通道默认选「无」= 其余会话无助手承接。
// 发送者的权限（响应/审核/忽略）在「用户」页按私聊/群设置，与绑定无关。
// config 是唯一事实源：所有操作走 IPC，界面随 config:state 广播重派生。

type Selection =
  | { kind: 'default'; channelId: string }
  | { kind: 'chat'; channelId: string; chatId: string }
  | { kind: 'ghost'; channelId: string }
  | null

const selectionKey = (selection: Selection): string | null => {
  if (selection === null) return null
  return selection.kind === 'chat'
    ? `chat:${selection.channelId}:${selection.chatId}`
    : `${selection.kind}:${selection.channelId}`
}

const defaultAssignment = (assistantId: string): ChatAssignment => ({
  assistantId,
  onlyMention: true,
  sendOutput: false,
})

/** 指派的可调选项（群触发条件 + 输出选项） */
type AssignmentPatch = Partial<Pick<ChatAssignment, 'onlyMention' | 'sendOutput'>>

export function BindingsPanel({ state }: { state: ConfigState }) {
  const intl = useIntl()

  const [chats, setChats] = useState<ChatInfo[]>([])
  const [drafts, setDrafts] = useState<DraftChat[]>([])
  const [selection, setSelection] = useState<Selection>(null)
  const [pickerChannel, setPickerChannel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 已知会话列表：历史库 + 新消息事件刷新
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void susie.invoke('history:chats').then((list) => {
        if (alive) setChats(list)
      })
    }
    refresh()
    const unsubscribe = susie.on('history:message', refresh)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const tree = useMemo(() => buildTree(state.config, chats, drafts), [state.config, chats, drafts])

  // 选中项在配置变化后可能消失（外部编辑等）→ 复位
  useEffect(() => {
    if (selection === null) return
    const entry = tree.find((item) => item.channelId === selection.channelId)
    const stillValid =
      entry !== undefined &&
      (selection.kind === 'ghost'
        ? entry.ghost
        : !entry.ghost && (selection.kind === 'default' || entry.rows.some((row) => row.chatId === selection.chatId)))
    if (!stillValid) setSelection(null)
  }, [tree, selection])

  const submit = useCallback(
    async (mutate: (assignments: BindingAssignments) => void): Promise<void> => {
      if (busy) return
      setBusy(true)
      const assignments = expandBindings(state.config.bindings)
      mutate(assignments)
      const result = await ipc.config.setBindings({
        bindings: canonicalizeBindings(assignments),
        expectedVersion: state.version,
      })
      setBusy(false)
      if (!result.ok) {
        setError(result.conflict ? intl.formatMessage({ id: 'bindings.error.conflictRefreshed' }) : result.message)
        return
      }
      setError(null)
    },
    [busy, state.config.bindings, state.version, intl],
  )

  const setAssistant = useCallback(
    (target: Selection, assistantId: string | null): void => {
      if (target === null || target.kind === 'ghost') return
      void submit((assignments) => {
        if (target.kind === 'default') {
          if (assistantId === null) delete assignments.wildcard[target.channelId]
          else assignments.wildcard[target.channelId] = defaultAssignment(assistantId)
        } else if (assistantId === null) {
          delete assignments.exact[target.channelId]?.[target.chatId]
        } else {
          const channelExact = (assignments.exact[target.channelId] ??= {})
          const existing = channelExact[target.chatId]
          // 换助手保留已配置的触发条件
          channelExact[target.chatId] =
            existing === undefined ? defaultAssignment(assistantId) : { ...existing, assistantId }
        }
      })
    },
    [submit],
  )

  /** 更新精确绑定的可调选项（群触发条件 / 输出选项） */
  const setTrigger = useCallback(
    (row: ChatRow, patch: AssignmentPatch): void => {
      void submit((assignments) => {
        const existing = assignments.exact[row.channelId]?.[row.chatId]
        if (existing === undefined) return
        const channelExact = (assignments.exact[row.channelId] ??= {})
        channelExact[row.chatId] = { ...existing, ...patch }
      })
    },
    [submit],
  )

  /** 更新通道默认绑定（chat_id='*'）的可调选项 */
  const setDefaultOption = useCallback(
    (channelId: string, patch: AssignmentPatch): void => {
      void submit((assignments) => {
        const existing = assignments.wildcard[channelId]
        if (existing === undefined) return
        assignments.wildcard[channelId] = { ...existing, ...patch }
      })
    },
    [submit],
  )

  /** 移除会话 = 删除其绑定与草稿 */
  const removeChat = useCallback(
    (row: ChatRow): void => {
      setDrafts((prev) => prev.filter((draft) => !(draft.channelId === row.channelId && draft.chatId === row.chatId)))
      setSelection(null)
      if (row.assignment !== null) {
        void submit((assignments) => {
          delete assignments.exact[row.channelId]?.[row.chatId]
        })
      }
    },
    [submit],
  )

  const cleanupGhost = useCallback(
    (channelId: string): void => {
      setDrafts((prev) => prev.filter((draft) => draft.channelId !== channelId))
      setSelection(null)
      void submit((assignments) => {
        delete assignments.exact[channelId]
        delete assignments.wildcard[channelId]
      })
    },
    [submit],
  )

  const addChat = useCallback((channelId: string, chatId: string, name: string | null): void => {
    setDrafts((prev) =>
      prev.some((draft) => draft.channelId === channelId && draft.chatId === chatId)
        ? prev
        : [...prev, { channelId, chatId, name }],
    )
    setPickerChannel(null)
    setSelection({ kind: 'chat', channelId, chatId })
  }, [])

  const assistantIds = state.config.assistants.map((assistant) => assistant.id)
  const selectedKey = selectionKey(selection)

  const selectedEntry = selection === null ? undefined : tree.find((item) => item.channelId === selection.channelId)
  const selectedRow =
    selection?.kind === 'chat' ? selectedEntry?.rows.find((row) => row.chatId === selection.chatId) : undefined

  return (
    <section className="mt-10">
      <h2 className="mb-3 text-base font-semibold">{intl.formatMessage({ id: 'bindings.title' })}</h2>
      <p className="mb-4 text-xs text-ink-muted">{intl.formatMessage({ id: 'bindings.hint' })}</p>
      <ErrorText message={error} />
      {tree.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-raised/50 p-6 text-sm text-ink-muted">
          {intl.formatMessage({ id: 'bindings.empty' })}
        </div>
      ) : (
        <div className="mt-3 flex min-h-96 overflow-hidden rounded-xl border border-line bg-raised">
          <nav className="w-72 shrink-0 overflow-y-auto border-r border-line p-2">
            {tree.map((entry) => (
              <ChannelSection
                key={entry.channelId}
                entry={entry}
                selectedKey={selectedKey}
                busy={busy}
                onSelect={setSelection}
                onAddChat={() => setPickerChannel(entry.channelId)}
              />
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {selection === null && (
              <p className="text-sm text-ink-muted">{intl.formatMessage({ id: 'bindings.detail.empty' })}</p>
            )}
            {selection?.kind === 'ghost' && selectedEntry !== undefined && (
              <GhostDetail channelId={selection.channelId} busy={busy} onCleanup={cleanupGhost} />
            )}
            {selection?.kind === 'default' && selectedEntry !== undefined && (
              <DefaultDetail
                key={`${selectedKey}@${state.version}`}
                entry={selectedEntry}
                assistantIds={assistantIds}
                busy={busy}
                onAssign={(assistantId) => setAssistant(selection, assistantId)}
                onOption={(patch) => setDefaultOption(selection.channelId, patch)}
              />
            )}
            {selection?.kind === 'chat' && selectedRow !== undefined && (
              <ChatDetail
                key={`${selectedKey}@${state.version}`}
                row={selectedRow}
                assistantIds={assistantIds}
                busy={busy}
                onAssign={(assistantId) => setAssistant(selection, assistantId)}
                onTrigger={setTrigger}
                onRemove={removeChat}
              />
            )}
          </div>
        </div>
      )}
      {pickerChannel !== null && (
        <ChatPickerModal
          channelId={pickerChannel}
          chats={chats}
          existingChatIds={
            new Set(tree.find((entry) => entry.channelId === pickerChannel)?.rows.map((row) => row.chatId) ?? [])
          }
          onPick={(chatId, name) => addChat(pickerChannel, chatId, name)}
          onClose={() => setPickerChannel(null)}
        />
      )}
    </section>
  )
}

// ---------- 左栏：树形导航 ----------

function ChannelSection({
  entry,
  selectedKey,
  busy,
  onSelect,
  onAddChat,
}: {
  entry: ChannelTree
  selectedKey: string | null
  busy: boolean
  onSelect: (selection: Selection) => void
  onAddChat: () => void
}) {
  const intl = useIntl()

  if (entry.ghost) {
    const key = `ghost:${entry.channelId}`
    return (
      <button
        type="button"
        onClick={() => onSelect({ kind: 'ghost', channelId: entry.channelId })}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-line/40 ${
          selectedKey === key ? 'bg-accent/10' : ''
        }`}
      >
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-red-500">{entry.channelId}</span>
        <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] text-red-500">
          {intl.formatMessage({ id: 'bindings.tree.ghost' })}
        </span>
      </button>
    )
  }

  const defaultKey = `default:${entry.channelId}`
  return (
    <div className="mb-1">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{entry.channelId}</span>
        <button
          type="button"
          title={intl.formatMessage({ id: 'bindings.tree.addChat' })}
          aria-label={intl.formatMessage({ id: 'bindings.tree.addChat' })}
          disabled={busy}
          onClick={onAddChat}
          className="rounded-md px-1.5 text-base leading-6 text-ink-muted transition-colors hover:bg-line/50 hover:text-ink disabled:opacity-40"
        >
          ＋
        </button>
      </div>
      <TreeRow
        selected={selectedKey === defaultKey}
        onClick={() => onSelect({ kind: 'default', channelId: entry.channelId })}
        title={intl.formatMessage({ id: 'bindings.tree.defaultChat' })}
        titleClass="text-ink-muted italic"
        subtitle={
          entry.defaultAssignment === null ? intl.formatMessage({ id: 'bindings.tree.defaultChat.none' }) : null
        }
      />
      {entry.rows.map((row) => (
        <TreeRow
          key={row.chatId}
          selected={selectedKey === `chat:${entry.channelId}:${row.chatId}`}
          onClick={() => onSelect({ kind: 'chat', channelId: entry.channelId, chatId: row.chatId })}
          title={row.name ?? row.chatId}
          titleClass={row.name === null ? 'font-mono text-xs' : ''}
          subtitle={chatTypeLabel(intl, row.chatType)}
        />
      ))}
    </div>
  )
}

function TreeRow({
  selected,
  onClick,
  title,
  titleClass,
  subtitle,
}: {
  selected: boolean
  onClick: () => void
  title: string
  titleClass: string
  subtitle: string | null
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full rounded-md py-1.5 pr-2 pl-5 text-left transition-colors hover:bg-line/40 ${
        selected ? 'bg-accent/10' : ''
      }`}
    >
      <span className={`block min-w-0 truncate text-sm ${titleClass}`}>{title}</span>
      {subtitle !== null && <span className="mt-0.5 block text-[11px] text-ink-muted">{subtitle}</span>}
    </button>
  )
}

function chatTypeLabel(intl: ReturnType<typeof useIntl>, chatType: string | null): string | null {
  switch (chatType) {
    case 'private':
      return intl.formatMessage({ id: 'bindings.type.private' })
    case 'group':
      return intl.formatMessage({ id: 'bindings.type.group' })
    case 'supergroup':
      return intl.formatMessage({ id: 'bindings.type.supergroup' })
    case 'channel':
      return intl.formatMessage({ id: 'bindings.type.channel' })
    case 'sender':
      return intl.formatMessage({ id: 'bindings.type.sender' })
    default:
      return null
  }
}

// ---------- 右栏：详情 ----------

function DefaultDetail({
  entry,
  assistantIds,
  busy,
  onAssign,
  onOption,
}: {
  entry: ChannelTree
  assistantIds: string[]
  busy: boolean
  onAssign: (assistantId: string | null) => void
  onOption: (patch: AssignmentPatch) => void
}) {
  const intl = useIntl()
  return (
    <div className="flex max-w-md flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold">{intl.formatMessage({ id: 'bindings.tree.defaultChat' })}</h3>
        <p className="mt-1 text-xs text-ink-muted">
          {entry.channelId} · {intl.formatMessage({ id: 'bindings.detail.default.hint' })}
        </p>
      </div>
      <Field label={intl.formatMessage({ id: 'bindings.detail.assistant' })}>
        <Select
          value={entry.defaultAssignment?.assistantId ?? ''}
          disabled={busy}
          onChange={(event) => onAssign(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">{intl.formatMessage({ id: 'bindings.detail.assistant.none' })}</option>
          {assistantIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </Select>
      </Field>
      {entry.defaultAssignment !== null && (
        <OutputOptions assignment={entry.defaultAssignment} busy={busy} onOption={onOption} />
      )}
    </div>
  )
}

/** 输出选项（精确绑定与通道默认共用）：执行过程内容是否随回复发送 */
function OutputOptions({
  assignment,
  busy,
  onOption,
}: {
  assignment: ChatAssignment
  busy: boolean
  onOption: (patch: AssignmentPatch) => void
}) {
  const intl = useIntl()
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <span className="text-xs font-medium text-ink-muted">{intl.formatMessage({ id: 'bindings.detail.output' })}</span>
      <fieldset disabled={busy} className="flex flex-col gap-1">
        <CheckboxField
          label={intl.formatMessage({ id: 'bindings.detail.output.sendOutput' })}
          checked={assignment.sendOutput}
          onChange={(value) => onOption({ sendOutput: value })}
        />
        <span className="text-xs text-ink-muted/70">
          {intl.formatMessage({ id: 'bindings.detail.output.sendOutput.hint' })}
        </span>
      </fieldset>
    </div>
  )
}

function ChatDetail({
  row,
  assistantIds,
  busy,
  onAssign,
  onTrigger,
  onRemove,
}: {
  row: ChatRow
  assistantIds: string[]
  busy: boolean
  onAssign: (assistantId: string | null) => void
  onTrigger: (row: ChatRow, patch: AssignmentPatch) => void
  onRemove: (row: ChatRow) => void
}) {
  const intl = useIntl()
  const typeLabel = chatTypeLabel(intl, row.chatType)
  const isGroupLike = row.chatType !== null && row.chatType !== 'private'

  return (
    <div className="flex max-w-md flex-col gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h3 className="min-w-0 truncate text-sm font-semibold">{row.name ?? row.chatId}</h3>
          {typeLabel !== null && (
            <span className="shrink-0 rounded bg-ink/5 px-1.5 py-0.5 text-[11px] text-ink-muted">{typeLabel}</span>
          )}
        </div>
        <p className="mt-1 font-mono text-xs text-ink-muted">
          {row.channelId} · {row.chatId}
        </p>
      </div>

      <Field label={intl.formatMessage({ id: 'bindings.detail.assistant' })}>
        <Select
          value={row.assignment?.assistantId ?? ''}
          disabled={busy}
          onChange={(event) => onAssign(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">{intl.formatMessage({ id: 'bindings.detail.assistant.follow' })}</option>
          {assistantIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </Select>
      </Field>

      {isGroupLike && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="text-xs font-medium text-ink-muted">
            {intl.formatMessage({ id: 'bindings.detail.trigger' })}
          </span>
          {row.assignment === null ? (
            <p className="text-xs text-ink-muted/70">
              {intl.formatMessage({ id: 'bindings.detail.trigger.followDefault' })}
            </p>
          ) : (
            <fieldset disabled={busy} className="flex flex-col gap-2">
              <CheckboxField
                label={intl.formatMessage({ id: 'bindings.detail.group.onlyMention' })}
                checked={row.assignment.onlyMention}
                onChange={(value) => onTrigger(row, { onlyMention: value })}
              />
            </fieldset>
          )}
        </div>
      )}

      {row.assignment !== null && (
        <OutputOptions assignment={row.assignment} busy={busy} onOption={(patch) => onTrigger(row, patch)} />
      )}

      <div className="border-t border-line pt-3">
        <Button variant="danger" disabled={busy} onClick={() => onRemove(row)}>
          {intl.formatMessage({ id: 'bindings.detail.remove' })}
        </Button>
        <p className="mt-1 text-xs text-ink-muted/70">{intl.formatMessage({ id: 'bindings.detail.remove.hint' })}</p>
      </div>
    </div>
  )
}

function GhostDetail({
  channelId,
  busy,
  onCleanup,
}: {
  channelId: string
  busy: boolean
  onCleanup: (channelId: string) => void
}) {
  const intl = useIntl()
  return (
    <div className="flex max-w-md flex-col gap-3">
      <h3 className="text-sm font-semibold text-red-500">
        {intl.formatMessage({ id: 'bindings.missingChannel' }, { id: channelId })}
      </h3>
      <div>
        <Button variant="danger" disabled={busy} onClick={() => onCleanup(channelId)}>
          {intl.formatMessage({ id: 'bindings.detail.ghost.cleanup' })}
        </Button>
      </div>
    </div>
  )
}

// ---------- 添加会话弹窗 ----------

function ChatPickerModal({
  channelId,
  chats,
  existingChatIds,
  onPick,
  onClose,
}: {
  channelId: string
  chats: ChatInfo[]
  existingChatIds: Set<string>
  onPick: (chatId: string, name: string | null) => void
  onClose: () => void
}) {
  const intl = useIntl()
  const [manual, setManual] = useState('')

  const candidates = chats.filter((chat) => chat.channelId === channelId && !existingChatIds.has(chat.chatId))
  // '*' 是数据层保留字（通道默认由「默认」行表达），空白会破坏 chat key 编码
  const manualValid = /^\S+$/.test(manual) && manual !== CHAT_ALL && !existingChatIds.has(manual)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="max-h-[70vh] w-96 overflow-y-auto rounded-xl border border-line bg-raised p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 className="mb-3 text-sm font-semibold">
          {intl.formatMessage({ id: 'bindings.picker.chat.title' }, { id: channelId })}
        </h3>
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
            <TextInput
              value={manual}
              placeholder="P:123456"
              onChange={(event) => setManual(event.target.value.trim())}
            />
          </Field>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" disabled={!manualValid} onClick={() => onPick(manual, null)}>
              {intl.formatMessage({ id: 'bindings.picker.chat.confirm' })}
            </Button>
            <Button onClick={onClose}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
