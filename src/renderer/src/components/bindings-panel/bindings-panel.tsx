import { useIntl } from 'react-intl'
import type { ConfigState } from '../../../../shared/config'
import { useBotIdentityMap } from '../../lib/ipc-query'
import { ErrorText } from '../form'
import { ChatDetail, DefaultDetail, GhostDetail, chatTypeLabel } from './chat-detail'
import { ChatPickerModal } from './chat-picker'
import type { ChannelTree } from './model'
import { useBindings, type Selection } from './use-bindings'

// 两栏主从式：左栏 channel → chat 树形导航，右栏为选中会话的配置。
// 绑定 = 路由：会话 → 助手 + 是否响应 + 触发/输出配置；通道默认的 respond 决定未列出会话是否响应。
// 发送者的权限（响应/审核/忽略）在「用户」页按私聊/群设置，与绑定无关。
// 状态与写操作全部住在 use-bindings.ts（config 是唯一事实源），本文件只组合视图；页面壳在「会话」页。

export function BindingsPanel({ state }: { state: ConfigState }) {
  const intl = useIntl()
  const panel = useBindings(state)
  const { tree, selection, selectedKey, selectedEntry, selectedRow, busy } = panel
  const identityMap = useBotIdentityMap()
  // 渠道以 getMe display name 展示（幽灵/未拉到身份时回退渠道 id）
  const channelLabel = (channelId: string): string => identityMap.get(channelId)?.name ?? channelId

  return (
    <div>
      <ErrorText message={panel.error} />
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
                label={channelLabel(entry.channelId)}
                selectedKey={selectedKey}
                busy={busy}
                onSelect={panel.setSelection}
                onAddChat={() => panel.setPickerChannel(entry.channelId)}
              />
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-y-auto p-5">
            {selection === null && (
              <p className="text-sm text-ink-muted">{intl.formatMessage({ id: 'bindings.detail.empty' })}</p>
            )}
            {selection?.kind === 'ghost' && selectedEntry !== undefined && (
              <GhostDetail channelId={selection.channelId} busy={busy} onCleanup={panel.cleanupGhost} />
            )}
            {selection?.kind === 'default' && selectedEntry !== undefined && (
              <DefaultDetail
                key={`${selectedKey}@${state.version}`}
                entry={selectedEntry}
                assistantOptions={panel.assistantOptions}
                busy={busy}
                onAssign={(assistantId) => panel.setAssistant(selection, assistantId)}
                onOption={(patch) => panel.setDefaultOption(selection.channelId, patch)}
              />
            )}
            {selection?.kind === 'chat' && selectedRow !== undefined && (
              <ChatDetail
                key={`${selectedKey}@${state.version}`}
                row={selectedRow}
                identity={identityMap.get(selection.channelId)}
                assistantOptions={panel.assistantOptions}
                busy={busy}
                onAssign={(assistantId) => panel.setAssistant(selection, assistantId)}
                onTrigger={panel.setTrigger}
                onRemove={panel.removeChat}
              />
            )}
          </div>
        </div>
      )}
      {panel.pickerChannel !== null && (
        <ChatPickerModal
          channelId={panel.pickerChannel}
          channelLabel={channelLabel(panel.pickerChannel)}
          chats={panel.chats}
          existingChatIds={
            new Set(tree.find((entry) => entry.channelId === panel.pickerChannel)?.rows.map((row) => row.chatId) ?? [])
          }
          // 频道（C:*）不允许作为绑定目标——bot 不参与 channel 会话循环，schema 层也会二次拒绝
          excludeChatTypes={['channel']}
          onPick={(chatId, name) => panel.addChat(panel.pickerChannel ?? '', chatId, name)}
          onClose={() => panel.setPickerChannel(null)}
        />
      )}
    </div>
  )
}

// ---------- 左栏：树形导航 ----------

function ChannelSection({
  entry,
  label,
  selectedKey,
  busy,
  onSelect,
  onAddChat,
}: {
  entry: ChannelTree
  /** 渠道显示名（getMe display name，回退渠道 id） */
  label: string
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
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-red-500">{label}</span>
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
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</span>
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
          entry.defaultAssignment === null
            ? intl.formatMessage({ id: 'bindings.tree.defaultChat.none' })
            : entry.defaultAssignment.respond
              ? null
              : intl.formatMessage({ id: 'bindings.tree.mute' })
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
          muted={row.assignment?.respond === false}
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
  muted = false,
}: {
  selected: boolean
  onClick: () => void
  title: string
  titleClass: string
  subtitle: string | null
  /** respond=false 的静音标记 */
  muted?: boolean
}) {
  const intl = useIntl()
  return (
    <button
      type="button"
      onClick={onClick}
      className={`block w-full rounded-md py-1.5 pr-2 pl-5 text-left transition-colors hover:bg-line/40 ${
        selected ? 'bg-accent/10' : ''
      }`}
    >
      <span className="flex items-center gap-2">
        <span className={`block min-w-0 flex-1 truncate text-sm ${titleClass}`}>{title}</span>
        {muted && (
          <span className="shrink-0 rounded bg-ink/5 px-1.5 py-0.5 text-[11px] text-ink-muted">
            {intl.formatMessage({ id: 'bindings.tree.defaultChat.none' })}
          </span>
        )}
      </span>
      {subtitle !== null && <span className="mt-0.5 block text-[11px] text-ink-muted">{subtitle}</span>}
    </button>
  )
}
