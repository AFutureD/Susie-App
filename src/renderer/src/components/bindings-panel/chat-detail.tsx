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

export function DefaultDetail({
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

export function ChatDetail({
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
