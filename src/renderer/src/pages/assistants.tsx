import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { AssistantConfig, ConfigState, ThinkingLevel } from '../../../shared/config'
import { THINKING_LEVELS } from '../../../shared/config'
import type { AgentModelOption } from '../../../shared/messages'
import { BindingsPanel } from '../components/bindings-panel/bindings-panel'
import { Button, ErrorText, Field, Select, TextInput } from '../components/form'
import { Page } from '../components/page'
import { configStateAtom } from '../lib/config-atoms'
import { ipc } from '../lib/ipc'
import { useConfigMutation } from '../lib/ipc-mutation'
import { toast } from '../lib/toast'

/** Codex 直连 agent 的固定 id（对位 main 的 CODEX_AGENT_ID） */
const CODEX_AGENT_ID = 'codex'

/** 在 Finder 打开 assistant 的生效工作目录（目录由 main 侧解析并确保存在） */
async function openWorkDir(id: string): Promise<void> {
  const result = await ipc.assistants.openWorkdir({ id })
  if (!result.ok) toast(result.message, 'error')
}

export function AssistantsPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [editing, setEditing] = useState<string | 'new' | null>(null)

  if (!state) {
    return <Page titleId="page.assistants.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  const mutation = useConfigMutation()

  const deleteAssistant = async (id: string) => {
    if (!window.confirm(intl.formatMessage({ id: 'assistants.deleteConfirm' }, { id }))) return
    await mutation.run((expectedVersion) => ipc.config.deleteAssistant({ id, expectedVersion }))
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
              {editing !== assistant.id && (
                <Button onClick={() => void openWorkDir(assistant.id)}>
                  {intl.formatMessage({ id: 'assistants.openWorkdir' })}
                </Button>
              )}
              <Button onClick={() => setEditing(editing === assistant.id ? null : assistant.id)}>
                {intl.formatMessage({ id: 'common.edit' })}
              </Button>
              <Button variant="danger" onClick={() => void deleteAssistant(assistant.id)}>
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

      <BindingsPanel state={state} />
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
  const [agentId, setAgentId] = useState(initial?.agent_id ?? CODEX_AGENT_ID)
  const [workDir, setWorkDir] = useState(initial?.work_dir ?? '')
  const [forwardTo, setForwardTo] = useState(initial?.forward_to ?? '')
  const [model, setModel] = useState(initial?.model ?? '')
  const [thinkingLevel, setThinkingLevel] = useState<string>(initial?.thinking_level ?? '')
  /** null = 枚举中 */
  const [agentIds, setAgentIds] = useState<string[] | null>(null)
  const [modelOptions, setModelOptions] = useState<AgentModelOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void ipc.agents.overview().then((overview) => {
      if (cancelled) return
      // 不支持 http MCP 的 agent（mcpHttp === false）拿不到 susie 工具（send_message 等），
      // 不进候选；null（探测失败/旧 manifest）视为未知，保守放行。codex 恒在候选（未装则运行时引导下载）
      const installed = overview
        .filter((agent) => agent.id !== CODEX_AGENT_ID && agent.source === 'installed' && agent.mcpHttp !== false)
        .map((agent) => agent.id)
      setAgentIds([CODEX_AGENT_ID, ...installed])
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 模型候选跟随 agent 枚举（codex 走 app-server 探针，ACP 起一次性会话）
  useEffect(() => {
    let cancelled = false
    setModelOptions(null)
    void ipc.agents.models({ agentId }).then((options) => {
      if (!cancelled) setModelOptions(options)
    })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const pickWorkDir = async () => {
    const dir = await ipc.app.pickDirectory()
    if (dir !== null) setWorkDir(dir)
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    const assistant: AssistantConfig = {
      id: id.trim(),
      agent_id: agentId,
      ...(workDir.trim() === '' ? {} : { work_dir: workDir.trim() }),
      ...(forwardTo.trim() === '' ? {} : { forward_to: forwardTo.trim() }),
      ...(model === '' ? {} : { model }),
      ...(thinkingLevel === '' ? {} : { thinking_level: thinkingLevel as ThinkingLevel }),
    }
    const result = await ipc.config.upsertAssistant({ assistant, expectedVersion: state.version })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onDone()
  }

  // 编辑既有配置时，当前值可能不在枚举结果里（agent 被卸载 / 手改 config）：保留为额外选项防止误改
  const knownAgents = agentIds ?? []
  const agentOptions = agentId !== '' && !knownAgents.includes(agentId) ? [agentId, ...knownAgents] : knownAgents
  const models = modelOptions ?? []
  const modelMissing = model !== '' && !models.some((option) => option.value === model)

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
          <Select
            value={agentId}
            onChange={(event) => {
              // 换 agent 后旧模型大概率无效，回落到 agent 默认
              setAgentId(event.target.value)
              setModel('')
            }}
          >
            {agentOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
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
          <Select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="">
              {intl.formatMessage({
                id: modelOptions === null ? 'assistants.models.loading' : 'assistants.model.default',
              })}
            </option>
            {modelMissing && <option value={model}>{model}</option>}
            {models.map((option) => (
              <option key={option.value} value={option.value} title={option.description}>
                {option.name === option.value ? option.value : `${option.name} · ${option.value}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label={intl.formatMessage({ id: 'assistants.field.thinking' })}
          hint={intl.formatMessage({ id: 'assistants.field.thinking.hint' })}
        >
          <Select value={thinkingLevel} onChange={(event) => setThinkingLevel(event.target.value)}>
            <option value="">{intl.formatMessage({ id: 'assistants.thinking.default' })}</option>
            {THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <ErrorText message={error} />
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || id.trim() === ''} onClick={() => void submit()}>
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        <Button onClick={onDone}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
      </div>
    </div>
  )
}
