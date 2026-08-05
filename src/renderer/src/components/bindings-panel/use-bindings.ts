import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChatAssignment, WildcardAssignment } from '../../../../shared/bindings'
import type { ConfigState } from '../../../../shared/config'
import { assistantLabel } from '../../lib/assistant-label'
import { useChatsQuery } from '../../lib/ipc-query'
import { buildTree, type ChatRow, type DraftChat } from './model'
import { useBindingsWriter } from './use-bindings-writer'

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

const newAssignment = (assistantId: string): WildcardAssignment => ({
  assistantId,
  respond: true,
  onlyMention: true,
  sendOutput: false,
})

/** 精确绑定的初始底座：跟随通道默认助手 */
const followAssignment = (): ChatAssignment => ({
  assistantId: null,
  respond: true,
  onlyMention: true,
  sendOutput: false,
})

/** 指派的可调选项（是否响应 + 群触发条件 + 输出选项） */
export type AssignmentPatch = Partial<Pick<ChatAssignment, 'respond' | 'onlyMention' | 'sendOutput'>>

export function useBindings(state: ConfigState) {
  const [drafts, setDrafts] = useState<DraftChat[]>([])
  const [selection, setSelection] = useState<Selection>(null)
  const [pickerChannel, setPickerChannel] = useState<string | null>(null)

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

  const { busy, error, submit } = useBindingsWriter(state)

  const setAssistant = useCallback(
    (target: Selection, assistantId: string | null): void => {
      if (target === null || target.kind === 'ghost') return
      void submit((assignments) => {
        if (target.kind === 'default') {
          // 通道默认必须有助手（不响应用 respond 表达）；换助手保留已配置的选项
          if (assistantId === null) return
          const existing = assignments.wildcard[target.channelId]
          assignments.wildcard[target.channelId] =
            existing === undefined ? newAssignment(assistantId) : { ...existing, assistantId }
        } else {
          // 精确绑定：null = 跟随通道默认助手（绑定保留）；换助手保留已配置的选项
          const channelExact = (assignments.exact[target.channelId] ??= {})
          const existing = channelExact[target.chatId]
          channelExact[target.chatId] =
            existing === undefined ? { ...followAssignment(), assistantId } : { ...existing, assistantId }
        }
      })
    },
    [submit],
  )

  /** 更新精确绑定的可调选项（是否响应 / 群触发条件 / 输出选项）；草稿会话以跟随默认为底座落盘 */
  const setTrigger = useCallback(
    (row: ChatRow, patch: AssignmentPatch): void => {
      void submit((assignments) => {
        const channelExact = (assignments.exact[row.channelId] ??= {})
        const existing = channelExact[row.chatId]
        channelExact[row.chatId] = { ...(existing ?? followAssignment()), ...patch }
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

  /** 添加会话 = 立即落盘一条「跟随渠道默认助手」的绑定（添加即响应，之后可再调整助手/选项）。
   *  draft 仅作 config 广播回流前的乐观渲染占位，防止选中项被 stillValid 复位。 */
  const addChat = useCallback(
    (channelId: string, chatId: string, name: string | null): void => {
      setDrafts((prev) =>
        prev.some((draft) => draft.channelId === channelId && draft.chatId === chatId)
          ? prev
          : [...prev, { channelId, chatId, name }],
      )
      setPickerChannel(null)
      setSelection({ kind: 'chat', channelId, chatId })
      void submit((assignments) => {
        const channelExact = (assignments.exact[channelId] ??= {})
        channelExact[chatId] ??= followAssignment()
      })
    },
    [submit],
  )

  const assistantOptions = state.config.assistants.map((assistant) => ({
    id: assistant.id,
    label: assistantLabel(assistant),
  }))
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
    assistantOptions,
    setAssistant,
    setTrigger,
    setDefaultOption,
    removeChat,
    cleanupGhost,
    addChat,
  }
}
