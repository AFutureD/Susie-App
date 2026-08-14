import { useRef, useState } from 'react'
import { useIntl } from 'react-intl'
import { expandBindings } from '../../../shared/bindings'
import { DEFAULT_ASSISTANT_ID, type ConfigState } from '../../../shared/config'
import { assistantLabel } from '../lib/assistant-label'
import { useBindingsWriter } from './bindings-panel/use-bindings-writer'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

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
      <Field>
        <FieldLabel htmlFor="default-binding-assistant">
          {intl.formatMessage({ id: 'defaultBinding.assistant' })}
        </FieldLabel>
        <NativeSelect
          id="default-binding-assistant"
          className="w-full"
          value={assistantId}
          disabled={writer.busy}
          onChange={(event) => setAssistantId(event.target.value)}
        >
          {state.config.assistants.map((assistant) => (
            <NativeSelectOption key={assistant.id} value={assistant.id}>
              {assistantLabel(assistant)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>

      <ToggleGroup
        orientation="vertical"
        variant="outline"
        className="w-full"
        value={respond === null ? [] : [respond ? 'yes' : 'no']}
        onValueChange={(value) => {
          const next = value[0]
          if (next === 'yes' || next === 'no') setRespond(next === 'yes')
        }}
      >
        <ToggleGroupItem
          value="yes"
          disabled={writer.busy}
          className="h-auto w-full flex-col items-start p-4 text-left whitespace-normal"
        >
          <span className="font-semibold">{intl.formatMessage({ id: 'defaultBinding.respond.yes.title' })}</span>
          <span className="text-xs leading-5 text-muted-foreground">
            {intl.formatMessage({ id: 'defaultBinding.respond.yes.desc' })}
          </span>
        </ToggleGroupItem>
        <ToggleGroupItem
          value="no"
          disabled={writer.busy}
          className="h-auto w-full flex-col items-start p-4 text-left whitespace-normal"
        >
          <span className="font-semibold">{intl.formatMessage({ id: 'defaultBinding.respond.no.title' })}</span>
          <span className="text-xs leading-5 text-muted-foreground">
            {intl.formatMessage({ id: 'defaultBinding.respond.no.desc' })}
          </span>
        </ToggleGroupItem>
      </ToggleGroup>

      {writer.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{writer.error}</AlertDescription>
        </Alert>
      )}
      <div>
        <Button disabled={writer.busy || respond === null} onClick={() => void confirm()}>
          {intl.formatMessage({ id: 'defaultBinding.confirm' })}
        </Button>
      </div>
    </div>
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
    <Dialog open onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-[28rem]">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: 'defaultBinding.title' })}</DialogTitle>
          <DialogDescription>{intl.formatMessage({ id: 'defaultBinding.subtitle' })}</DialogDescription>
        </DialogHeader>
        <ChannelDefaultBindingPanel state={state} channelId={channelId} onDone={finish} />
        <Button variant="link" className="justify-self-start" onClick={dismiss}>
          {intl.formatMessage({ id: 'defaultBinding.later' })}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
