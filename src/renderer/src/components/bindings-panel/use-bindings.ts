import { useCallback, useEffect, useMemo, useState } from 'react'
import { useIntl } from 'react-intl'
import {
  canonicalizeBindings,
  expandBindings,
  type BindingAssignments,
  type ChatAssignment,
} from '../../../../shared/bindings'
import type { ConfigState } from '../../../../shared/config'
import { ipc } from '../../lib/ipc'
import { useChatsQuery } from '../../lib/ipc-query'
import { buildTree, type ChatRow, type DraftChat } from './model'

// 绑定面板的 container hook：状态 + 数据 + 全部写操作。
// 视图（树/详情/弹窗）只消费这里输出的 props 包——config 是唯一事实源，
// 所有操作走 IPC，界面随 config.state 广播重派生。

export type Selection =
  | { kind: 'default'; channelId: string }
  | { kind: 'chat'; channelId: string; chatId: string }
  | { kind: 'ghost'; channelId: string }
  | null

export const selectionKey = (selection: Selection): string | null => {
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
export type AssignmentPatch = Partial<Pick<ChatAssignment, 'onlyMention' | 'sendOutput'>>

export function useBindings(state: ConfigState) {
  const intl = useIntl()

  const [drafts, setDrafts] = useState<DraftChat[]>([])
  const [selection, setSelection] = useState<Selection>(null)
  const [pickerChannel, setPickerChannel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 已知会话列表：共享查询缓存（history.message 事件自动失效）
  const { data: chatsData } = useChatsQuery()
  const chats = useMemo(() => chatsData ?? [], [chatsData])

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

  return {
    chats,
    tree,
    selection,
    setSelection,
    selectedKey,
    selectedEntry,
    selectedRow,
    pickerChannel,
    setPickerChannel,
    busy,
    error,
    assistantIds,
    setAssistant,
    setTrigger,
    setDefaultOption,
    removeChat,
    cleanupGhost,
    addChat,
  }
}
