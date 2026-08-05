import { useRef, useState } from 'react'
import { useIntl } from 'react-intl'
import { expandBindings } from '../../../shared/bindings'
import { DEFAULT_ASSISTANT_ID, type ConfigState } from '../../../shared/config'
import { assistantLabel } from '../lib/assistant-label'
import { useBindingsWriter } from './bindings-panel/use-bindings-writer'
import { Button, ErrorText, Field, Select } from './form'

// 「绑定默认助手」：渠道/Bot 新增后为通道默认绑定（chat_id='*'）选助手 + 是否响应。
// 弹窗（渠道页两条添加路径）与 onboarding 绑定步共用同一面板；
// 弹窗被关闭/打断时回落写 { default 助手, respond: false }，保证渠道必有默认绑定。

/** 兜底选中的助手 id：default 缺失（理论上被 store 补建兜住）时退化到首个 */
function preferredAssistantId(state: ConfigState): string {
  return (
    state.config.assistants.find((assistant) => assistant.id === DEFAULT_ASSISTANT_ID)?.id ??
    state.config.assistants[0]?.id ??
    DEFAULT_ASSISTANT_ID
  )
}

export function ChannelDefaultBindingPanel({
  state,
  channelId,
  onDone,
}: {
  state: ConfigState
  channelId: string
  onDone: () => void
}) {
  const intl = useIntl()
  const writer = useBindingsWriter(state)
  const [assistantId, setAssistantId] = useState(() => preferredAssistantId(state))
  // 是否响应无预设：必须显式二选一，选定前确认不可用
  const [respond, setRespond] = useState<boolean | null>(null)

  const confirm = async (): Promise<void> => {
    if (respond === null) return
    const ok = await writer.submit((assignments) => {
      assignments.wildcard[channelId] = { assistantId, respond, onlyMention: true, sendOutput: false }
    })
    if (ok) onDone()
  }

  return (
    <div className="flex flex-col gap-3">
      <Field label={intl.formatMessage({ id: 'defaultBinding.assistant' })}>
        <Select value={assistantId} disabled={writer.busy} onChange={(event) => setAssistantId(event.target.value)}>
          {state.config.assistants.map((assistant) => (
            <option key={assistant.id} value={assistant.id}>
              {assistantLabel(assistant)}
            </option>
          ))}
        </Select>
      </Field>

      <RespondOption
        title={intl.formatMessage({ id: 'defaultBinding.respond.yes.title' })}
        desc={intl.formatMessage({ id: 'defaultBinding.respond.yes.desc' })}
        selected={respond === true}
        disabled={writer.busy}
        onPick={() => setRespond(true)}
      />
      <RespondOption
        title={intl.formatMessage({ id: 'defaultBinding.respond.no.title' })}
        desc={intl.formatMessage({ id: 'defaultBinding.respond.no.desc' })}
        selected={respond === false}
        disabled={writer.busy}
        onPick={() => setRespond(false)}
      />

      <ErrorText message={writer.error} />
      <div>
        <Button variant="primary" disabled={writer.busy || respond === null} onClick={() => void confirm()}>
          {intl.formatMessage({ id: 'defaultBinding.confirm' })}
        </Button>
      </div>
    </div>
  )
}

function RespondOption({
  title,
  desc,
  selected,
  disabled,
  onPick,
}: {
  title: string
  desc: string
  selected: boolean
  disabled: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      aria-pressed={selected}
      className={`rounded-xl border p-4 text-left transition-colors disabled:opacity-50 ${
        selected ? 'border-accent bg-accent/5' : 'border-line bg-raised hover:border-accent/60'
      }`}
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-1 block text-xs leading-5 text-ink-muted">{desc}</span>
    </button>
  )
}

/** 渠道新增后的默认助手绑定弹窗；关闭/打断 = 回落 default 助手 + 不响应 */
export function ChannelDefaultBindingModal({
  state,
  channelId,
  onClose,
}: {
  state: ConfigState
  channelId: string
  onClose: () => void
}) {
  const intl = useIntl()
  const writer = useBindingsWriter(state)
  // 一次性收尾：确认成功与关闭回落只允许发生其一（防遮罩+按钮双触发）
  const settledRef = useRef(false)

  const finish = (): void => {
    if (settledRef.current) return
    settledRef.current = true
    onClose()
  }

  const dismiss = (): void => {
    if (settledRef.current) return
    settledRef.current = true
    // 已有通道默认（面板确认成功后广播回流、或渠道重加残留旧绑定）则不覆盖
    if (expandBindings(state.config.bindings).wildcard[channelId] === undefined) {
      void writer.submit((assignments) => {
        assignments.wildcard[channelId] = {
          assistantId: preferredAssistantId(state),
          respond: false,
          onlyMention: true,
          sendOutput: false,
        }
      })
    }
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={dismiss}>
      <div
        className="flex max-h-[80vh] w-[28rem] flex-col gap-3 overflow-y-auto rounded-xl border border-line bg-raised p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <h3 className="text-sm font-semibold">{intl.formatMessage({ id: 'defaultBinding.title' })}</h3>
          <p className="mt-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'defaultBinding.subtitle' })}</p>
        </div>
        <ChannelDefaultBindingPanel state={state} channelId={channelId} onDone={finish} />
        <button
          type="button"
          onClick={dismiss}
          className="self-start text-xs text-ink-muted underline-offset-2 hover:underline"
        >
          {intl.formatMessage({ id: 'defaultBinding.later' })}
        </button>
      </div>
    </div>
  )
}
