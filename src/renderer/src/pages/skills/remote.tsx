import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import {
  skillDirsForAgent,
  type RegistrySkillEntry,
  type RemoteSkillEntry,
  type SkillDir,
  type SkillInstallResult,
  type SkillScope,
} from '../../../../shared/skills'
import { Button, ErrorText, Field, FieldGroup, Select, TextInput } from '../../components/form'
import { Modal } from '../../components/modal'
import { assistantLabel } from '../../lib/assistant-label'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc } from '../../lib/ipc'
import { useIpcQuery } from '../../lib/ipc-query'
import { toast } from '../../lib/toast'
import { ScopeChip } from './index'

// 获取技能弹窗（技能页入口）：GitHub 仓库（owner/repo 或链接）与 skillhubs registry 两个来源；
// 安装目标在二级弹窗中选择：位置（全局/助手）决定根目录，agent 多选决定容器目录集合
// （agent→目录映射去重后逐个安装），目标已存在时二次确认覆盖。

/** Codex 直连 agent 的固定 id（对位 main 的 CODEX_AGENT_ID） */
const CODEX_AGENT_ID = 'codex'

type InstallRequest =
  { kind: 'repo'; sessionId: string; relPath: string; label: string } | { kind: 'registry'; name: string }

export function SkillsAcquireModal({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }) {
  const intl = useIntl()
  const [request, setRequest] = useState<InstallRequest | null>(null)

  return (
    <>
      <Modal
        title={intl.formatMessage({ id: 'skills.remote.title' })}
        panelClassName="flex max-h-[85vh] w-[44rem] max-w-[90vw] flex-col p-5"
        onClose={onClose}
      >
        <div className="min-h-0 flex-1 overflow-y-auto">
          <RepoSection onInstall={setRequest} />
          <div className="mt-5 border-t border-line pt-5">
            <RegistrySection onInstall={setRequest} />
          </div>
        </div>
        <div className="mt-4 flex shrink-0 justify-end border-t border-line pt-4">
          <Button onClick={onClose}>{intl.formatMessage({ id: 'common.close' })}</Button>
        </div>
      </Modal>
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
        <TextInput
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
          <ErrorText message={error} />
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
                        kind: 'repo',
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

function RegistrySection({ onInstall }: { onInstall: (request: InstallRequest) => void }) {
  const intl = useIntl()
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RegistrySkillEntry[] | null>(null)

  const search = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const res = await ipc.skills.searchRegistry({ keyword })
    setBusy(false)
    if (res.ok) {
      setResult(res.skills)
    } else {
      setResult(null)
      setError(res.message)
    }
  }

  return (
    <section>
      <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'skills.remote.registry.title' })}</h2>
      <p className="mt-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'skills.remote.registry.hint' })}</p>
      <div className="mt-3 flex gap-2">
        <TextInput
          value={keyword}
          placeholder={intl.formatMessage({ id: 'skills.remote.registry.placeholder' })}
          onChange={(event) => setKeyword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void search()
          }}
        />
        <Button className="shrink-0" disabled={busy} onClick={() => void search()}>
          {intl.formatMessage({ id: busy ? 'skills.remote.registry.searching' : 'skills.remote.registry.search' })}
        </Button>
      </div>
      {error !== null && (
        <div className="mt-3">
          <ErrorText message={error} />
        </div>
      )}
      {result !== null && (
        <div className="mt-3">
          {result.length === 0 ? (
            <p className="text-sm text-ink-muted">{intl.formatMessage({ id: 'skills.remote.registry.empty' })}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {result.map((skill) => (
                <div
                  key={skill.name}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{skill.name}</span>
                      {skill.version !== '' && (
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-accent">
                          v{skill.version}
                        </span>
                      )}
                    </div>
                    {skill.description !== '' && (
                      <p className="mt-0.5 truncate text-xs text-ink-muted">{skill.description}</p>
                    )}
                    <p className="mt-0.5 truncate text-[11px] text-ink-muted/80">
                      {[
                        skill.tags.join(' · '),
                        skill.downloadCount !== null
                          ? intl.formatMessage(
                              { id: 'skills.remote.registry.downloads' },
                              { count: skill.downloadCount },
                            )
                          : '',
                      ]
                        .filter((part) => part !== '')
                        .join(' · ')}
                    </p>
                  </div>
                  <Button className="shrink-0" onClick={() => onInstall({ kind: 'registry', name: skill.name })}>
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
  const toggleAgent = (id: string) =>
    setPicked(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id])

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
    return request.kind === 'repo'
      ? ipc.skills.installFromRepo({ sessionId: request.sessionId, relPath: request.relPath, target, overwrite })
      : ipc.skills.installFromRegistry({ name: request.name, target, overwrite })
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
    if (existing.length > 0 && window.confirm(intl.formatMessage({ id: 'skills.install.overwriteConfirm' }))) {
      for (const dir of existing) {
        const result = await doInstall(dir, true)
        if (result.ok) done.push(result.path)
        else failures.push(result.message)
      }
      existing.length = 0
    }
    setBusy(false)
    if (failures.length > 0) {
      setError(failures.join('\n'))
      return
    }
    if (done.length > 0) {
      toast(intl.formatMessage({ id: 'skills.install.done' }, { path: done.join('、') }))
      onInstalled()
      onClose()
    }
    // done 为空且用户放弃覆盖：什么都没发生，留在弹窗
  }

  const sourceLabel = request.kind === 'repo' ? request.label : `skillhubs · ${request.name}`
  const rootLabel = scope === 'global' ? '~' : intl.formatMessage({ id: 'skills.install.dir.workdir' })
  const missingAssistant = scope === 'assistant' && effectiveAssistant === ''

  return (
    <Modal
      title={intl.formatMessage({ id: 'skills.install.title' })}
      panelClassName="max-h-[70vh] w-[26rem] overflow-y-auto p-5"
      onClose={onClose}
    >
      <p className="truncate rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs text-ink-muted">
        {sourceLabel}
      </p>
      <div className="mt-4 flex flex-col gap-4">
        <FieldGroup label={intl.formatMessage({ id: 'skills.install.scope' })}>
          <div className="flex gap-1.5">
            <ScopeChip
              label={intl.formatMessage({ id: 'skills.scope.global' })}
              active={scope === 'global'}
              onClick={() => {
                setScope('global')
                setPicked(null)
              }}
            />
            <ScopeChip
              label={intl.formatMessage({ id: 'skills.scope.assistant' })}
              active={scope === 'assistant'}
              onClick={() => {
                setScope('assistant')
                setPicked(null)
              }}
            />
          </div>
        </FieldGroup>

        {scope === 'assistant' &&
          (assistants.length === 0 ? (
            <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'skills.assistant.none' })}</p>
          ) : (
            <Field
              label={intl.formatMessage({ id: 'skills.install.assistant' })}
              hint={intl.formatMessage({ id: 'skills.install.assistant.hint' })}
            >
              <Select
                value={effectiveAssistant}
                onChange={(event) => {
                  setAssistantId(event.target.value)
                  setPicked(null)
                }}
              >
                {assistants.map((assistant) => (
                  <option key={assistant.id} value={assistant.id}>
                    {assistantLabel(assistant)}
                  </option>
                ))}
              </Select>
            </Field>
          ))}

        <FieldGroup
          label={intl.formatMessage({ id: 'skills.install.agent' })}
          hint={
            candidates.length > 0 && selected.length === 0
              ? intl.formatMessage({ id: 'skills.install.agents.empty' })
              : undefined
          }
        >
          {candidates.length === 0 ? (
            <p className="py-1.5 text-xs text-ink-muted">
              {agentsQuery.error ?? intl.formatMessage({ id: 'common.loading' })}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((id) => (
                <ScopeChip key={id} label={id} active={selected.includes(id)} onClick={() => toggleAgent(id)} />
              ))}
            </div>
          )}
        </FieldGroup>

        {dirGroups.length > 0 && (
          <FieldGroup label={intl.formatMessage({ id: 'skills.install.dir' })}>
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

        <ErrorText message={error} />
      </div>
      <div className="mt-5 flex justify-end gap-2 border-t border-line pt-4">
        <Button onClick={onClose}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
        <Button
          variant="primary"
          disabled={busy || missingAssistant || dirGroups.length === 0}
          onClick={() => void submit()}
        >
          {intl.formatMessage({ id: 'skills.install.confirm' })}
        </Button>
      </div>
    </Modal>
  )
}
