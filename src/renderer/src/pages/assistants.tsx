import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { AssistantConfig, ConfigState, ThinkingLevel } from '../../../shared/config'
import { THINKING_LEVELS } from '../../../shared/config'
import { DEFAULT_ASSISTANT_ID } from '../../../shared/config'
import type { AgentModelOption } from '../../../shared/messages'
import { AssistantSkillsModal } from '../components/assistant-skills-modal'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Page } from '../components/page'
import { DEFAULT_ASSISTANT_LABEL, assistantLabel } from '../lib/assistant-label'
import { configStateAtom } from '../lib/config-atoms'
import { ipc } from '../lib/ipc'
import { useConfigMutation } from '../lib/ipc-mutation'
import { toast } from '@/components/ui/toast'

/** Codex 直连 agent 的固定 id（对位 main 的 CODEX_AGENT_ID） */
const CODEX_AGENT_ID = 'codex'

/** 在 Finder 打开 assistant 的生效工作目录（目录由 main 侧解析并确保存在） */
async function openWorkDir(id: string): Promise<void> {
  const result = await ipc.assistants.openWorkdir({ id })
  if (!result.ok) toast.add({ title: result.message, type: 'error' })
}

export function AssistantsPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [skillsFor, setSkillsFor] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<AssistantConfig | null>(null)
  const mutation = useConfigMutation()

  if (!state) {
    return <Page titleId="page.assistants.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  const deleteAssistant = async (assistant: AssistantConfig) => {
    setDeleteTarget(null)
    await mutation.run((expectedVersion) => ipc.config.deleteAssistant({ id: assistant.id, expectedVersion }))
  }

  return (
    <Page
      titleId="page.assistants.title"
      actions={
        <Button disabled={editing === 'new'} onClick={() => setEditing('new')}>
          {intl.formatMessage({ id: 'assistants.add' })}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {state.config.assistants.map((assistant) => (
          <div key={assistant.id} className="rounded-xl border border-line bg-raised p-4">
            <div className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{assistantLabel(assistant)}</span>
                  <Badge variant="secondary">{assistant.id}</Badge>
                  <Badge>{assistant.agent_id}</Badge>
                </div>
                <div className="mt-1 flex gap-4 font-mono text-xs text-ink-muted">
                  {assistant.work_dir && <span>cwd {assistant.work_dir}</span>}
                  {assistant.forward_to && <span>→ {assistant.forward_to}</span>}
                </div>
              </div>
              {editing !== assistant.id && (
                <Button variant="outline" onClick={() => setSkillsFor(assistant.id)}>
                  {intl.formatMessage({ id: 'assistants.skills' })}
                </Button>
              )}
              {editing !== assistant.id && (
                <Button variant="outline" onClick={() => void openWorkDir(assistant.id)}>
                  {intl.formatMessage({ id: 'assistants.openWorkdir' })}
                </Button>
              )}
              <Button variant="outline" onClick={() => setEditing(editing === assistant.id ? null : assistant.id)}>
                {intl.formatMessage({ id: 'common.edit' })}
              </Button>
              {assistant.id !== DEFAULT_ASSISTANT_ID && (
                <Button variant="destructive" onClick={() => setDeleteTarget(assistant)}>
                  {intl.formatMessage({ id: 'common.delete' })}
                </Button>
              )}
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

        {editing === 'new' && (
          <div className="rounded-xl border border-line bg-raised p-4">
            <AssistantForm state={state} onDone={() => setEditing(null)} />
          </div>
        )}
      </div>

      {skillsFor !== null && (
        <AssistantSkillsModal
          assistantId={skillsFor}
          label={(() => {
            const target = state.config.assistants.find((assistant) => assistant.id === skillsFor)
            return target === undefined ? undefined : assistantLabel(target)
          })()}
          onClose={() => setSkillsFor(null)}
        />
      )}
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{intl.formatMessage({ id: 'common.delete' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage(
                { id: 'assistants.deleteConfirm' },
                { id: deleteTarget === null ? '' : assistantLabel(deleteTarget) },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{intl.formatMessage({ id: 'common.cancel' })}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleteTarget !== null) void deleteAssistant(deleteTarget)
              }}
            >
              {intl.formatMessage({ id: 'common.delete' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
  const [name, setName] = useState(initial?.name ?? '')
  const [agentId, setAgentId] = useState(initial?.agent_id ?? CODEX_AGENT_ID)
  // default 助手名称固定为「默认」：输入禁用，提交不写 name
  const isDefault = initial?.id === DEFAULT_ASSISTANT_ID
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
      ...(isDefault || name.trim() === '' ? {} : { name: name.trim() }),
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
    <div className="mt-4 flex flex-col gap-5 border-t border-line pt-4">
      <FieldSet>
        <FieldLegend>{intl.formatMessage({ id: 'assistants.section.basic' })}</FieldLegend>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="assistant-id">{intl.formatMessage({ id: 'assistants.field.id' })}</FieldLabel>
            <Input
              id="assistant-id"
              value={id}
              onChange={(event) => setId(event.target.value)}
              disabled={initial !== undefined}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="assistant-name">{intl.formatMessage({ id: 'assistants.field.name' })}</FieldLabel>
            <Input
              id="assistant-name"
              value={isDefault ? DEFAULT_ASSISTANT_LABEL : name}
              disabled={isDefault}
              onChange={(event) => setName(event.target.value)}
              placeholder={id.trim() === '' ? undefined : id.trim()}
            />
            <FieldDescription>
              {intl.formatMessage({ id: isDefault ? 'assistants.field.name.fixedHint' : 'assistants.field.name.hint' })}
            </FieldDescription>
          </Field>
        </div>
      </FieldSet>

      <FieldSet>
        <FieldLegend>{intl.formatMessage({ id: 'assistants.section.agent' })}</FieldLegend>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="assistant-agent">{intl.formatMessage({ id: 'assistants.field.agent' })}</FieldLabel>
            <NativeSelect
              id="assistant-agent"
              value={agentId}
              onChange={(event) => {
                // 换 agent 后旧模型大概率无效，回落到 agent 默认
                setAgentId(event.target.value)
                setModel('')
              }}
            >
              {agentOptions.map((option) => (
                <NativeSelectOption key={option} value={option}>
                  {option}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>{intl.formatMessage({ id: 'assistants.field.agent.hint' })}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="assistant-model">{intl.formatMessage({ id: 'assistants.field.model' })}</FieldLabel>
            <NativeSelect id="assistant-model" value={model} onChange={(event) => setModel(event.target.value)}>
              <NativeSelectOption value="">
                {intl.formatMessage({
                  id: modelOptions === null ? 'assistants.models.loading' : 'assistants.model.default',
                })}
              </NativeSelectOption>
              {modelMissing && <NativeSelectOption value={model}>{model}</NativeSelectOption>}
              {models.map((option) => (
                <NativeSelectOption key={option.value} value={option.value} title={option.description}>
                  {option.name === option.value ? option.value : `${option.name} · ${option.value}`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>{intl.formatMessage({ id: 'assistants.field.model.hint' })}</FieldDescription>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="assistant-thinking">
              {intl.formatMessage({ id: 'assistants.field.thinking' })}
            </FieldLabel>
            <NativeSelect
              id="assistant-thinking"
              value={thinkingLevel}
              onChange={(event) => setThinkingLevel(event.target.value)}
            >
              <NativeSelectOption value="">
                {intl.formatMessage({ id: 'assistants.thinking.default' })}
              </NativeSelectOption>
              {THINKING_LEVELS.map((level) => (
                <NativeSelectOption key={level} value={level}>
                  {level}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <FieldDescription>{intl.formatMessage({ id: 'assistants.field.thinking.hint' })}</FieldDescription>
          </Field>
        </div>
        {/* 路径可能很长，工作目录独占整行 */}
        <Field>
          <FieldLabel htmlFor="assistant-workdir">{intl.formatMessage({ id: 'assistants.field.workdir' })}</FieldLabel>
          <div className="flex gap-1.5">
            <Input
              id="assistant-workdir"
              value={workDir}
              onChange={(event) => setWorkDir(event.target.value)}
              placeholder="/absolute/path"
            />
            <Button variant="outline" className="shrink-0" onClick={() => void pickWorkDir()}>
              {intl.formatMessage({ id: 'assistants.pickDir' })}
            </Button>
          </div>
          <FieldDescription>{intl.formatMessage({ id: 'assistants.field.workdir.hint' })}</FieldDescription>
        </Field>
      </FieldSet>

      <FieldSet>
        <FieldLegend>{intl.formatMessage({ id: 'assistants.section.misc' })}</FieldLegend>
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="assistant-forward">
              {intl.formatMessage({ id: 'assistants.field.forward' })}
            </FieldLabel>
            <Input
              id="assistant-forward"
              value={forwardTo}
              onChange={(event) => setForwardTo(event.target.value)}
              placeholder="G:-100123456"
            />
            <FieldDescription>{intl.formatMessage({ id: 'assistants.field.forward.hint' })}</FieldDescription>
          </Field>
        </div>
      </FieldSet>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button disabled={busy || id.trim() === ''} onClick={() => void submit()}>
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        <Button variant="outline" onClick={onDone}>
          {intl.formatMessage({ id: 'common.cancel' })}
        </Button>
      </div>
    </div>
  )
}
