import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { AssistantConfig, ChatBinding, ConfigState } from '../../../shared/config'
import { CHAT_ALL, DEFAULT_ASSISTANT_ID } from '../../../shared/config'
import { Button, ErrorText, Field, Select, TextArea, TextInput } from '../components/form'
import { Page } from '../components/page'
import { configStateAtom } from '../lib/config-atoms'
import { susie } from '../lib/ipc'

export function AssistantsPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [editing, setEditing] = useState<string | 'new' | null>(null)

  if (!state) {
    return <Page titleId="page.assistants.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  const deleteAssistant = async (id: string) => {
    if (!window.confirm(intl.formatMessage({ id: 'assistants.deleteConfirm' }, { id }))) return
    const result = await susie.invoke('config:delete-assistant', { id, expectedVersion: state.version })
    if (!result.ok) window.alert(result.message)
  }

  return (
    <Page titleId="page.assistants.title">
      <div className="flex flex-col gap-3">
        {state.config.assistants.map((assistant) => (
          <div key={assistant.id} className="rounded-xl border border-line bg-raised p-4">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{assistant.id}</span>
                  <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                    {assistant.agent_id}
                  </span>
                </div>
                <div className="mt-1 flex gap-4 font-mono text-xs text-ink-muted">
                  {assistant.work_dir && <span>cwd {assistant.work_dir}</span>}
                  {assistant.forward_to && <span>→ {assistant.forward_to}</span>}
                </div>
              </div>
              <Button onClick={() => setEditing(editing === assistant.id ? null : assistant.id)}>
                {intl.formatMessage({ id: 'common.edit' })}
              </Button>
              <Button
                variant="danger"
                disabled={assistant.id === DEFAULT_ASSISTANT_ID}
                onClick={() => void deleteAssistant(assistant.id)}
              >
                {intl.formatMessage({ id: 'common.delete' })}
              </Button>
            </div>
            {editing === assistant.id && (
              <AssistantForm
                key={`${assistant.id}@${state.version}`}
                initial={assistant}
                state={state}
                onDone={() => setEditing(null)}
              />
            )}
          </div>
        ))}

        {editing === 'new' ? (
          <div className="rounded-xl border border-line bg-raised p-4">
            <AssistantForm state={state} onDone={() => setEditing(null)} />
          </div>
        ) : (
          <div>
            <Button variant="primary" onClick={() => setEditing('new')}>
              {intl.formatMessage({ id: 'assistants.add' })}
            </Button>
          </div>
        )}
      </div>

      <BindingsSection state={state} />
    </Page>
  )
}

function AssistantForm({
  initial,
  state,
  onDone,
}: {
  initial?: AssistantConfig
  state: ConfigState
  onDone: () => void
}) {
  const intl = useIntl()
  const [id, setId] = useState(initial?.id ?? '')
  const [agentId, setAgentId] = useState(initial?.agent_id ?? 'codex')
  const [workDir, setWorkDir] = useState(initial?.work_dir ?? '')
  const [forwardTo, setForwardTo] = useState(initial?.forward_to ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [models, setModels] = useState((initial?.models ?? []).join(', '))
  const [instruction, setInstruction] = useState(initial?.instruction ?? '')
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pickWorkDir = async () => {
    const dir = await susie.invoke('dialog:pick-directory')
    if (dir !== null) setWorkDir(dir)
  }

  const previewInstruction = async () => {
    const result = await susie.invoke('config:preview-template', {
      template: instruction.trim() === '' ? '{{SUSIE_MCP_NAME}}（内置模板）' : instruction,
    })
    setPreview(result.ok ? result.rendered : `模板错误：${result.message}`)
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    const modelList = models
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
    const assistant: AssistantConfig = {
      id: id.trim(),
      agent_id: agentId.trim() === '' ? 'codex' : agentId.trim(),
      ...(workDir.trim() === '' ? {} : { work_dir: workDir.trim() }),
      ...(forwardTo.trim() === '' ? {} : { forward_to: forwardTo.trim() }),
      ...(model.trim() === '' ? {} : { model: model.trim() }),
      ...(modelList.length === 0 ? {} : { models: modelList }),
      ...(instruction.trim() === '' ? {} : { instruction }),
    }
    const result = await susie.invoke('config:upsert-assistant', { assistant, expectedVersion: state.version })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onDone()
  }

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
      <div className="grid grid-cols-2 gap-3">
        <Field label={intl.formatMessage({ id: 'assistants.field.id' })}>
          <TextInput value={id} onChange={(event) => setId(event.target.value)} disabled={initial !== undefined} />
        </Field>
        <Field
          label={intl.formatMessage({ id: 'assistants.field.agent' })}
          hint={intl.formatMessage({ id: 'assistants.field.agent.hint' })}
        >
          <TextInput value={agentId} onChange={(event) => setAgentId(event.target.value)} placeholder="codex" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={intl.formatMessage({ id: 'assistants.field.workdir' })}
          hint={intl.formatMessage({ id: 'assistants.field.workdir.hint' })}
        >
          <div className="flex gap-1.5">
            <TextInput
              value={workDir}
              onChange={(event) => setWorkDir(event.target.value)}
              placeholder="/absolute/path"
            />
            <Button onClick={() => void pickWorkDir()}>{intl.formatMessage({ id: 'assistants.pickDir' })}</Button>
          </div>
        </Field>
        <Field
          label={intl.formatMessage({ id: 'assistants.field.forward' })}
          hint={intl.formatMessage({ id: 'assistants.field.forward.hint' })}
        >
          <TextInput
            value={forwardTo}
            onChange={(event) => setForwardTo(event.target.value)}
            placeholder="G:-100123456"
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={intl.formatMessage({ id: 'assistants.field.model' })}
          hint={intl.formatMessage({ id: 'assistants.field.model.hint' })}
        >
          <TextInput value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-5.2-codex" />
        </Field>
        <Field
          label={intl.formatMessage({ id: 'assistants.field.models' })}
          hint={intl.formatMessage({ id: 'assistants.field.models.hint' })}
        >
          <TextInput
            value={models}
            onChange={(event) => setModels(event.target.value)}
            placeholder="gpt-5.2-codex, gpt-5.2-codex-mini"
          />
        </Field>
      </div>
      <Field
        label={intl.formatMessage({ id: 'assistants.field.instruction' })}
        hint={intl.formatMessage({ id: 'assistants.field.instruction.hint' })}
      >
        <TextArea rows={5} value={instruction} onChange={(event) => setInstruction(event.target.value)} />
      </Field>
      {preview !== null && (
        <pre className="max-h-48 overflow-y-auto rounded-md border border-line bg-surface px-3 py-2 font-mono text-[11px] leading-4 whitespace-pre-wrap text-ink-muted">
          {preview}
        </pre>
      )}
      <ErrorText message={error} />
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || id.trim() === ''} onClick={() => void submit()}>
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        <Button onClick={() => void previewInstruction()}>
          {intl.formatMessage({ id: 'assistants.previewTemplate' })}
        </Button>
        <Button onClick={onDone}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
      </div>
    </div>
  )
}

function BindingsSection({ state }: { state: ConfigState }) {
  const intl = useIntl()
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const bindings = state.config.bindings

  const deleteBinding = async (index: number) => {
    const result = await susie.invoke('config:delete-binding', { index, expectedVersion: state.version })
    if (!result.ok) window.alert(result.message)
  }

  const moveBinding = async (index: number, direction: 'up' | 'down') => {
    const result = await susie.invoke('config:move-binding', { index, direction, expectedVersion: state.version })
    if (!result.ok) window.alert(result.message)
  }

  return (
    <section className="mt-10">
      <h2 className="mb-3 text-base font-semibold">{intl.formatMessage({ id: 'bindings.title' })}</h2>
      <p className="mb-4 text-xs text-ink-muted">{intl.formatMessage({ id: 'bindings.hint' })}</p>
      <div className="flex flex-col gap-2">
        {bindings.length === 0 && editing !== 'new' && (
          <div className="rounded-xl border border-dashed border-line bg-raised/50 p-6 text-sm text-ink-muted">
            {intl.formatMessage({ id: 'bindings.empty' })}
          </div>
        )}

        {bindings.map((binding, index) => (
          <div key={`${index}@${state.version}`} className="rounded-xl border border-line bg-raised px-4 py-3">
            {editing === index ? (
              <BindingForm index={index} initial={binding} state={state} onDone={() => setEditing(null)} />
            ) : (
              <BindingSummary
                binding={binding}
                index={index}
                total={bindings.length}
                state={state}
                onMove={(direction) => void moveBinding(index, direction)}
                onEdit={() => setEditing(index)}
                onDelete={() => void deleteBinding(index)}
              />
            )}
          </div>
        ))}

        {editing === 'new' ? (
          <div className="rounded-xl border border-line bg-raised px-4 py-3">
            <BindingForm index={null} state={state} onDone={() => setEditing(null)} />
          </div>
        ) : (
          <div>
            <Button variant="primary" onClick={() => setEditing('new')}>
              {intl.formatMessage({ id: 'bindings.add' })}
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}

function BindingSummary({
  binding,
  index,
  total,
  state,
  onMove,
  onEdit,
  onDelete,
}: {
  binding: ChatBinding
  index: number
  total: number
  state: ConfigState
  onMove: (direction: 'up' | 'down') => void
  onEdit: () => void
  onDelete: () => void
}) {
  const intl = useIntl()
  // channel 引用允许悬空（删除频道不清理绑定）；assistant 引用由 schema 保证存在
  const channelMissing = !(binding.channel in state.config.channels)

  return (
    <div className="flex items-center gap-3">
      <span className="w-5 shrink-0 text-center font-mono text-xs text-ink-muted/70">{index + 1}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={`text-sm font-semibold ${channelMissing ? 'text-red-500' : ''}`}
          title={
            channelMissing ? intl.formatMessage({ id: 'bindings.missingChannel' }, { id: binding.channel }) : undefined
          }
        >
          {binding.channel}
        </span>
        {binding.chat_ids.map((chatId, chatIndex) => (
          <span
            key={`${chatId}-${chatIndex}`}
            className={`rounded bg-ink/5 px-1.5 py-0.5 text-[11px] text-ink-muted ${chatId === CHAT_ALL ? '' : 'font-mono'}`}
          >
            {chatId === CHAT_ALL ? intl.formatMessage({ id: 'bindings.chat.all' }) : chatId}
          </span>
        ))}
        <span className="text-xs text-ink-muted/70">→</span>
        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
          {binding.assistant_id}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <div className="flex items-center">
          <MoveButton
            direction="up"
            disabled={index === 0}
            label={intl.formatMessage({ id: 'bindings.moveUp' })}
            onClick={() => onMove('up')}
          />
          <MoveButton
            direction="down"
            disabled={index === total - 1}
            label={intl.formatMessage({ id: 'bindings.moveDown' })}
            onClick={() => onMove('down')}
          />
        </div>
        <Button onClick={onEdit}>{intl.formatMessage({ id: 'common.edit' })}</Button>
        <Button variant="danger" onClick={onDelete}>
          {intl.formatMessage({ id: 'common.delete' })}
        </Button>
      </div>
    </div>
  )
}

function MoveButton({
  direction,
  disabled,
  label,
  onClick,
}: {
  direction: 'up' | 'down'
  disabled: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-md px-1.5 py-1 text-sm text-ink-muted transition-colors hover:bg-line/50 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {direction === 'up' ? '↑' : '↓'}
    </button>
  )
}

function BindingForm({
  index,
  initial,
  state,
  onDone,
}: {
  index: number | null
  initial?: ChatBinding
  state: ConfigState
  onDone: () => void
}) {
  const intl = useIntl()
  const channelIds = Object.keys(state.config.channels)
  const assistantIds = state.config.assistants.map((a) => a.id)

  const [channel, setChannel] = useState(initial?.channel ?? channelIds[0] ?? '')
  const [chatIds, setChatIds] = useState((initial?.chat_ids ?? [CHAT_ALL]).join(', '))
  const [assistantId, setAssistantId] = useState(initial?.assistant_id ?? DEFAULT_ASSISTANT_ID)
  const [busy, setBusy] = useState(false)

  const dirty =
    initial === undefined ||
    channel !== initial.channel ||
    assistantId !== initial.assistant_id ||
    chatIds !== initial.chat_ids.join(', ')

  const save = async () => {
    setBusy(true)
    const binding: ChatBinding = {
      channel,
      chat_ids: chatIds
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== ''),
      assistant_id: assistantId,
    }
    if (binding.chat_ids.length === 0) binding.chat_ids = [CHAT_ALL]
    const result = await susie.invoke('config:upsert-binding', { index, binding, expectedVersion: state.version })
    setBusy(false)
    if (!result.ok) {
      window.alert(result.message)
      return
    }
    onDone()
  }

  const channelOptions = channel !== '' && !channelIds.includes(channel) ? [channel, ...channelIds] : channelIds

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] gap-3">
        <Field label={intl.formatMessage({ id: 'bindings.field.channel' })}>
          <Select value={channel} onChange={(event) => setChannel(event.target.value)}>
            {channelOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={intl.formatMessage({ id: 'bindings.field.chats' })}
          hint={intl.formatMessage({ id: 'bindings.field.chats.hint' })}
        >
          <TextInput value={chatIds} onChange={(event) => setChatIds(event.target.value)} />
        </Field>
        <Field label={intl.formatMessage({ id: 'bindings.field.assistant' })}>
          <Select value={assistantId} onChange={(event) => setAssistantId(event.target.value)}>
            {assistantIds.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || !dirty || channel === ''} onClick={() => void save()}>
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        <Button onClick={onDone}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
      </div>
    </div>
  )
}
