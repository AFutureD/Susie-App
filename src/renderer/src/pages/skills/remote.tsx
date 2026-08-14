import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import {
  skillDirsForAgent,
  type RemoteSkillEntry,
  type SkillDir,
  type SkillInstallResult,
  type SkillScope,
} from '../../../../shared/skills'
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
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldTitle } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { assistantLabel } from '../../lib/assistant-label'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc } from '../../lib/ipc'
import { useIpcQuery } from '../../lib/ipc-query'
import { toast } from '@/components/ui/toast'

// 获取技能弹窗（技能页入口）：从 GitHub 仓库（owner/repo 或链接）选择技能；
// 安装目标在二级弹窗中选择：位置（全局/助手）决定根目录，agent 多选决定容器目录集合
// （agent→目录映射去重后逐个安装），目标已存在时二次确认覆盖。

/** Codex 直连 agent 的固定 id（对位 main 的 CODEX_AGENT_ID） */
const CODEX_AGENT_ID = 'codex'

type InstallRequest = { sessionId: string; relPath: string; label: string }

export function SkillsAcquireModal({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }) {
  const intl = useIntl()
  const [request, setRequest] = useState<InstallRequest | null>(null)

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <DialogContent className="flex max-h-[85vh] max-w-[90vw] flex-col overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage({ id: 'skills.remote.title' })}</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <RepoSection onInstall={setRequest} />
          </div>
          <div className="mt-4 flex shrink-0 justify-end border-t border-line pt-4">
            <Button variant="outline" onClick={onClose}>
              {intl.formatMessage({ id: 'common.close' })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      {request !== null && (
        <InstallTargetModal request={request} onClose={() => setRequest(null)} onInstalled={onInstalled} />
      )}
    </>
  )
}

function RepoSection({ onInstall }: { onInstall: (request: InstallRequest) => void }) {
  const intl = useIntl()
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ sessionId: string; repoLabel: string; skills: RemoteSkillEntry[] } | null>(
    null,
  )

  const fetchRepo = async () => {
    if (busy || source.trim() === '') return
    setBusy(true)
    setError(null)
    const res = await ipc.skills.listRepo({ source: source.trim() })
    setBusy(false)
    if (res.ok) {
      setResult(res)
    } else {
      setResult(null)
      setError(res.message)
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'skills.remote.repo.title' })}</h2>
      <p className="mt-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'skills.remote.repo.hint' })}</p>
      <div className="mt-3 flex gap-2">
        <Input
          value={source}
          placeholder="owner/repo 或 https://github.com/..."
          onChange={(event) => setSource(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void fetchRepo()
          }}
        />
        <Button className="shrink-0" disabled={busy || source.trim() === ''} onClick={() => void fetchRepo()}>
          {intl.formatMessage({ id: busy ? 'skills.remote.repo.fetching' : 'skills.remote.repo.fetch' })}
        </Button>
      </div>
      {error !== null && (
        <div className="mt-3">
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}
      {result !== null && (
        <div className="mt-3">
          <p className="mb-2 text-xs text-ink-muted">
            {intl.formatMessage({ id: 'skills.remote.repo.result' }, { label: result.repoLabel })}
          </p>
          {result.skills.length === 0 ? (
            <p className="text-sm text-ink-muted">{intl.formatMessage({ id: 'skills.remote.repo.empty' })}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {result.skills.map((skill) => (
                <div
                  key={skill.relPath}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{skill.name}</span>
                      <span className="truncate rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-accent">
                        {skill.relPath}
                      </span>
                    </div>
                    {skill.description !== '' && (
                      <p className="mt-0.5 truncate text-xs text-ink-muted">{skill.description}</p>
                    )}
                  </div>
                  <Button
                    className="shrink-0"
                    onClick={() =>
                      onInstall({
                        sessionId: result.sessionId,
                        relPath: skill.relPath,
                        label: `${result.repoLabel} · ${skill.name}`,
                      })
                    }
                  >
                    {intl.formatMessage({ id: 'skills.install' })}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function InstallTargetModal({
  request,
  onClose,
  onInstalled,
}: {
  request: InstallRequest
  onClose: () => void
  onInstalled: () => void
}) {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const assistants = state?.config.assistants ?? []
  const [scope, setScope] = useState<SkillScope>('global')
  const [assistantId, setAssistantId] = useState('')
  /** 手动勾选的 agent 集合；null = 未动过，跟随默认（全局取首个候选，助手取其绑定 agent） */
  const [picked, setPicked] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [overwritePending, setOverwritePending] = useState<{
    existing: SkillDir[]
    done: string[]
    failures: string[]
  } | null>(null)

  // agent 候选：本机可用（codex 内建恒可用）且技能目录在支持范围；
  // 助手维度额外并入其绑定的 agent（可能未安装——映射非空即可作为安装目标）
  const agentsQuery = useIpcQuery('agents.overview', () => ipc.agents.overview())
  const effectiveAssistant =
    assistantId !== '' && assistants.some((assistant) => assistant.id === assistantId)
      ? assistantId
      : (assistants[0]?.id ?? '')
  const boundAgent =
    scope === 'assistant' ? (assistants.find((assistant) => assistant.id === effectiveAssistant)?.agent_id ?? '') : ''
  const candidates = (agentsQuery.data ?? [])
    .filter((agent) => (agent.id === CODEX_AGENT_ID || agent.source !== null) && skillDirsForAgent(agent.id).length > 0)
    .map((agent) => agent.id)
  if (boundAgent !== '' && !candidates.includes(boundAgent) && skillDirsForAgent(boundAgent).length > 0) {
    candidates.unshift(boundAgent)
  }

  const defaultPick =
    scope === 'assistant'
      ? candidates.includes(boundAgent)
        ? [boundAgent]
        : []
      : candidates.length > 0
        ? [candidates[0] as string]
        : []
  const selected = (picked ?? defaultPick).filter((id) => candidates.includes(id))
  // 选中 agent → 容器目录去重分组（同目录的 agent 合并展示、只装一次）
  const dirGroups: { dir: SkillDir; agents: string[] }[] = []
  for (const id of selected) {
    for (const dir of skillDirsForAgent(id)) {
      const group = dirGroups.find((item) => item.dir === dir)
      if (group !== undefined) group.agents.push(id)
      else dirGroups.push({ dir, agents: [id] })
    }
  }

  const doInstall = (dir: SkillDir, overwrite: boolean): Promise<SkillInstallResult> => {
    const target = { scope, ...(scope === 'assistant' ? { assistantId: effectiveAssistant } : {}), dir }
    return ipc.skills.installFromRepo({ sessionId: request.sessionId, relPath: request.relPath, target, overwrite })
  }

  const finishInstall = (done: string[], failures: string[]): void => {
    setBusy(false)
    if (failures.length > 0) {
      setError(failures.join('\n'))
      return
    }
    if (done.length > 0) {
      toast.add({ title: intl.formatMessage({ id: 'skills.install.done' }, { path: done.join('、') }), type: 'info' })
      onInstalled()
      onClose()
    }
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    const done: string[] = []
    const existing: SkillDir[] = []
    const failures: string[] = []
    // 逐目录安装（数量 ≤ 目录种类数，顺序执行方便聚合覆盖确认）
    for (const { dir } of dirGroups) {
      const result = await doInstall(dir, false)
      if (result.ok) done.push(result.path)
      else if (result.exists) existing.push(dir)
      else failures.push(result.message)
    }
    if (existing.length > 0) {
      setBusy(false)
      setOverwritePending({ existing, done, failures })
      return
    }
    finishInstall(done, failures)
  }

  const overwrite = async (): Promise<void> => {
    if (overwritePending === null) return
    const { existing, done, failures } = overwritePending
    setOverwritePending(null)
    setBusy(true)
    for (const dir of existing) {
      const result = await doInstall(dir, true)
      if (result.ok) done.push(result.path)
      else failures.push(result.message)
    }
    finishInstall(done, failures)
  }

  const cancelOverwrite = (): void => {
    if (overwritePending === null) return
    const { done, failures } = overwritePending
    setOverwritePending(null)
    finishInstall(done, failures)
  }

  const rootLabel = scope === 'global' ? '~' : intl.formatMessage({ id: 'skills.install.dir.workdir' })
  const missingAssistant = scope === 'assistant' && effectiveAssistant === ''

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <DialogContent className="max-h-[70vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage({ id: 'skills.install.title' })}</DialogTitle>
          </DialogHeader>
          <p className="truncate rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink-muted">
            {request.label}
          </p>
          <div className="mt-4 flex flex-col gap-4">
            <FieldGroup>
              <FieldTitle>{intl.formatMessage({ id: 'skills.install.scope' })}</FieldTitle>
              <ToggleGroup
                variant="outline"
                size="sm"
                value={[scope]}
                onValueChange={(value) => {
                  const next = value[0]
                  if (next !== 'global' && next !== 'assistant') return
                  setScope(next)
                  setPicked(null)
                }}
              >
                <ToggleGroupItem value="global">{intl.formatMessage({ id: 'skills.scope.global' })}</ToggleGroupItem>
                <ToggleGroupItem value="assistant">
                  {intl.formatMessage({ id: 'skills.scope.assistant' })}
                </ToggleGroupItem>
              </ToggleGroup>
            </FieldGroup>

            {scope === 'assistant' &&
              (assistants.length === 0 ? (
                <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'skills.assistant.none' })}</p>
              ) : (
                <Field>
                  <FieldLabel htmlFor="skill-install-assistant">
                    {intl.formatMessage({ id: 'skills.install.assistant' })}
                  </FieldLabel>
                  <NativeSelect
                    id="skill-install-assistant"
                    value={effectiveAssistant}
                    onChange={(event) => {
                      setAssistantId(event.target.value)
                      setPicked(null)
                    }}
                  >
                    {assistants.map((assistant) => (
                      <NativeSelectOption key={assistant.id} value={assistant.id}>
                        {assistantLabel(assistant)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <FieldDescription>{intl.formatMessage({ id: 'skills.install.assistant.hint' })}</FieldDescription>
                </Field>
              ))}

            <FieldGroup>
              <FieldTitle>{intl.formatMessage({ id: 'skills.install.agent' })}</FieldTitle>
              {candidates.length > 0 && selected.length === 0 && (
                <FieldDescription>{intl.formatMessage({ id: 'skills.install.agents.empty' })}</FieldDescription>
              )}
              {candidates.length === 0 ? (
                <p className="py-1.5 text-xs text-ink-muted">
                  {agentsQuery.error ?? intl.formatMessage({ id: 'common.loading' })}
                </p>
              ) : (
                <ToggleGroup
                  multiple
                  variant="outline"
                  size="sm"
                  className="flex-wrap"
                  value={selected}
                  onValueChange={setPicked}
                >
                  {candidates.map((id) => (
                    <ToggleGroupItem key={id} value={id}>
                      {id}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              )}
            </FieldGroup>

            {dirGroups.length > 0 && (
              <FieldGroup>
                <FieldTitle>{intl.formatMessage({ id: 'skills.install.dir' })}</FieldTitle>
                <div className="flex flex-col gap-1.5">
                  {dirGroups.map(({ dir, agents }) => (
                    <div
                      key={dir}
                      className="flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5"
                    >
                      <span className="flex shrink-0 flex-wrap gap-1">
                        {agents.map((id) => (
                          <span
                            key={id}
                            className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent"
                          >
                            {id}
                          </span>
                        ))}
                      </span>
                      <span className="text-xs text-ink-muted/70">→</span>
                      <span className="truncate font-mono text-xs">
                        {rootLabel}/{dir}
                      </span>
                    </div>
                  ))}
                </div>
              </FieldGroup>
            )}

            {error !== null && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
          <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
            <Button variant="outline" onClick={onClose}>
              {intl.formatMessage({ id: 'common.cancel' })}
            </Button>
            <Button
              variant="default"
              disabled={busy || missingAssistant || dirGroups.length === 0}
              onClick={() => void submit()}
            >
              {intl.formatMessage({ id: 'skills.install.confirm' })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={overwritePending !== null}
        onOpenChange={(open) => {
          if (!open) cancelOverwrite()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{intl.formatMessage({ id: 'skills.install.confirm' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({ id: 'skills.install.overwriteConfirm' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{intl.formatMessage({ id: 'common.cancel' })}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void overwrite()}>
              {intl.formatMessage({ id: 'skills.install.confirm' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
