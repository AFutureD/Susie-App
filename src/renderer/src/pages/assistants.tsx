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
  const [adding, setAdding] = useState(false)

  const deleteBinding = async (index: number) => {
    const result = await susie.invoke('config:delete-binding', { index, expectedVersion: state.version })
    if (!result.ok) window.alert(result.message)
  }

  return (
    <section className="mt-10">
      <h2 className="mb-3 text-base font-semibold">{intl.formatMessage({ id: 'bindings.title' })}</h2>
      <p className="mb-4 text-xs text-ink-muted">{intl.formatMessage({ id: 'bindings.hint' })}</p>
      <div className="flex flex-col gap-2">
        {state.config.bindings.map((binding, index) => (
          <BindingRow
            key={`${index}@${state.version}`}
            index={index}
            initial={binding}
            state={state}
            onDelete={() => void deleteBinding(index)}
          />
        ))}
        {adding ? (
          <BindingRow index={null} state={state} onDone={() => setAdding(false)} />
        ) : (
          <div>
            <Button variant="primary" onClick={() => setAdding(true)}>
              {intl.formatMessage({ id: 'bindings.add' })}
            </Button>
          </div>
        )}
      </div>
    </section>
  )
}

function BindingRow({
  index,
  initial,
  state,
  onDelete,
  onDone,
}: {
  index: number | null
  initial?: ChatBinding
  state: ConfigState
  onDelete?: () => void
  onDone?: () => void
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
    onDone?.()
  }

  const channelOptions = channel !== '' && !channelIds.includes(channel) ? [channel, ...channelIds] : channelIds

  return (
    <div className="flex items-end gap-2 rounded-lg border border-line bg-raised p-3">
      <Field label={intl.formatMessage({ id: 'bindings.field.channel' })}>
        <Select value={channel} onChange={(event) => setChannel(event.target.value)}>
          {channelOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex-1">
        <Field
          label={intl.formatMessage({ id: 'bindings.field.chats' })}
          hint={intl.formatMessage({ id: 'bindings.field.chats.hint' })}
        >
          <TextInput value={chatIds} onChange={(event) => setChatIds(event.target.value)} />
        </Field>
      </div>
      <Field label={intl.formatMessage({ id: 'bindings.field.assistant' })}>
        <Select value={assistantId} onChange={(event) => setAssistantId(event.target.value)}>
          {assistantIds.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex gap-2 pb-0.5">
        <Button variant="primary" disabled={busy || !dirty || channel === ''} onClick={() => void save()}>
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        {onDelete && (
          <Button variant="danger" onClick={onDelete}>
            {intl.formatMessage({ id: 'common.delete' })}
          </Button>
        )}
        {onDone && <Button onClick={onDone}>{intl.formatMessage({ id: 'common.cancel' })}</Button>}
      </div>
    </div>
  )
}
