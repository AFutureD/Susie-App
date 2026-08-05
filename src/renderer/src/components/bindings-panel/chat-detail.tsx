import { useIntl } from 'react-intl'
import type { ChatAssignment } from '../../../../shared/bindings'
import { Button, CheckboxField, Field, Select } from '../form'
import type { ChannelTree, ChatRow } from './model'
import type { AssignmentPatch } from './use-bindings'

// 右栏详情：选中会话/通道默认/幽灵频道的配置表单（纯展示，写操作经 use-bindings 的回调）。

export function chatTypeLabel(intl: ReturnType<typeof useIntl>, chatType: string | null): string | null {
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

export interface AssistantOption {
  id: string
  label: string
}

export function DefaultDetail({
  entry,
  assistantOptions,
  busy,
  onAssign,
  onOption,
}: {
  entry: ChannelTree
  assistantOptions: AssistantOption[]
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
          {/* 通道默认必须指定助手（不响应用下方开关表达）；legacy 无默认绑定时显示占位 */}
          {entry.defaultAssignment === null && (
            <option value="" disabled>
              {intl.formatMessage({ id: 'bindings.detail.assistant.unset' })}
            </option>
          )}
          {assistantOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      {entry.defaultAssignment !== null && (
        <>
          <fieldset disabled={busy} className="flex flex-col gap-1 border-t border-line pt-3">
            <CheckboxField
              label={intl.formatMessage({ id: 'bindings.detail.respond.default' })}
              checked={entry.defaultAssignment.respond}
              onChange={(value) => onOption({ respond: value })}
            />
            <span className="text-xs text-ink-muted/70">
              {intl.formatMessage({ id: 'bindings.detail.respond.default.hint' })}
            </span>
          </fieldset>
          <OutputOptions assignment={entry.defaultAssignment} busy={busy} onOption={onOption} />
        </>
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

/** 草稿会话（尚无绑定落盘）在表单中的展示底座：跟随默认 + 各选项默认值 */
const FOLLOW_BASE = { assistantId: null, respond: true, onlyMention: true, sendOutput: false } as const

export function ChatDetail({
  row,
  assistantOptions,
  busy,
  onAssign,
  onTrigger,
  onRemove,
}: {
  row: ChatRow
  assistantOptions: AssistantOption[]
  busy: boolean
  onAssign: (assistantId: string | null) => void
  onTrigger: (row: ChatRow, patch: AssignmentPatch) => void
  onRemove: (row: ChatRow) => void
}) {
  const intl = useIntl()
  const typeLabel = chatTypeLabel(intl, row.chatType)
  const isGroupLike = row.chatType !== null && row.chatType !== 'private'
  // 选项编辑对草稿同样可用（setTrigger 以跟随默认为底座落盘），展示值与底座一致
  const assignment = row.assignment ?? FOLLOW_BASE

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
          value={assignment.assistantId ?? ''}
          disabled={busy}
          onChange={(event) => onAssign(event.target.value === '' ? null : event.target.value)}
        >
          <option value="">{intl.formatMessage({ id: 'bindings.detail.assistant.follow' })}</option>
          {assistantOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>

      <fieldset disabled={busy} className="flex flex-col gap-1 border-t border-line pt-3">
        <CheckboxField
          label={intl.formatMessage({ id: 'bindings.detail.respond.chat' })}
          checked={assignment.respond}
          onChange={(value) => onTrigger(row, { respond: value })}
        />
        <span className="text-xs text-ink-muted/70">
          {intl.formatMessage({ id: 'bindings.detail.respond.chat.hint' })}
        </span>
      </fieldset>

      {isGroupLike && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <span className="text-xs font-medium text-ink-muted">
            {intl.formatMessage({ id: 'bindings.detail.trigger' })}
          </span>
          <fieldset disabled={busy} className="flex flex-col gap-2">
            <CheckboxField
              label={intl.formatMessage({ id: 'bindings.detail.group.onlyMention' })}
              checked={assignment.onlyMention}
              onChange={(value) => onTrigger(row, { onlyMention: value })}
            />
          </fieldset>
        </div>
      )}

      <OutputOptions assignment={assignment} busy={busy} onOption={(patch) => onTrigger(row, patch)} />

      <div className="border-t border-line pt-3">
        <Button variant="danger" disabled={busy} onClick={() => onRemove(row)}>
          {intl.formatMessage({ id: 'bindings.detail.remove' })}
        </Button>
        <p className="mt-1 text-xs text-ink-muted/70">{intl.formatMessage({ id: 'bindings.detail.remove.hint' })}</p>
      </div>
    </div>
  )
}

export function GhostDetail({
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
