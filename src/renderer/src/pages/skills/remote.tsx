import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { Link } from 'react-router'
import {
  SKILL_DIRS,
  skillDirsForAgent,
  type RegistrySkillEntry,
  type RemoteSkillEntry,
  type SkillDir,
  type SkillInstallResult,
  type SkillScope,
} from '../../../../shared/skills'
import { Button, ErrorText, Field, FieldGroup, Select, TextInput } from '../../components/form'
import { Modal } from '../../components/modal'
import { Page } from '../../components/page'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc } from '../../lib/ipc'
import { toast } from '../../lib/toast'
import { ScopeChip } from './index'

// 获取技能子页（/skills/remote）：GitHub 仓库（owner/repo 或链接）与 skillhubs registry 两个来源；
// 安装目标（全局/助手 × 容器目录）在弹窗中选择，目标已存在时二次确认覆盖。

type InstallRequest =
  { kind: 'repo'; sessionId: string; relPath: string; label: string } | { kind: 'registry'; name: string }

export function SkillsRemotePage() {
  const intl = useIntl()
  const [request, setRequest] = useState<InstallRequest | null>(null)

  return (
    <Page
      titleId="page.skills.remote.title"
      actions={
        <Link to="/skills" className="text-sm text-ink-muted transition-colors hover:text-ink">
          {intl.formatMessage({ id: 'skills.remote.back' })}
        </Link>
      }
    >
      <div className="flex flex-col gap-5">
        <RepoSection onInstall={setRequest} />
        <RegistrySection onInstall={setRequest} />
      </div>
      {request !== null && <InstallTargetModal request={request} onClose={() => setRequest(null)} />}
    </Page>
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
    <section className="rounded-xl border border-line bg-raised p-5">
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
        <div className="mt-3 border-t border-line pt-3">
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
    <section className="rounded-xl border border-line bg-raised p-5">
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
        <div className="mt-3 border-t border-line pt-3">
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

/** 目录 → 读取方说明（对齐 shared/skills.ts 的映射表） */
const DIR_HINTS: Record<SkillDir, string> = {
  '.claude/skills': 'skills.install.dir.hint.claude',
  '.pi/skills': 'skills.install.dir.hint.pi',
  '.agents/skills': 'skills.install.dir.hint.agents',
}

function InstallTargetModal({ request, onClose }: { request: InstallRequest; onClose: () => void }) {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const assistants = state?.config.assistants ?? []
  const [scope, setScope] = useState<SkillScope>('global')
  const [assistantId, setAssistantId] = useState(assistants[0]?.id ?? '')
  const [dir, setDir] = useState<SkillDir>('.agents/skills')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 选中助手后目录默认跟随该 agent 的首个可读目录
  const defaultDirFor = (id: string): SkillDir => {
    const assistant = assistants.find((item) => item.id === id)
    return assistant !== undefined ? (skillDirsForAgent(assistant.agent_id)[0] ?? '.agents/skills') : '.agents/skills'
  }

  const doInstall = (overwrite: boolean): Promise<SkillInstallResult> => {
    const target = { scope, ...(scope === 'assistant' ? { assistantId } : {}), dir }
    return request.kind === 'repo'
      ? ipc.skills.installFromRepo({ sessionId: request.sessionId, relPath: request.relPath, target, overwrite })
      : ipc.skills.installFromRegistry({ name: request.name, target, overwrite })
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    let result = await doInstall(false)
    if (!result.ok && result.exists && window.confirm(intl.formatMessage({ id: 'skills.install.overwriteConfirm' }))) {
      result = await doInstall(true)
    }
    setBusy(false)
    if (result.ok) {
      toast(intl.formatMessage({ id: 'skills.install.done' }, { path: result.path }))
      onClose()
    } else {
      setError(result.message)
    }
  }

  const sourceLabel = request.kind === 'repo' ? request.label : `skillhubs · ${request.name}`

  return (
    <Modal
      title={intl.formatMessage({ id: 'skills.install.title' })}
      panelClassName="w-[26rem] overflow-y-auto p-5"
      onClose={onClose}
    >
      <p className="truncate font-mono text-xs text-ink-muted">{sourceLabel}</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <FieldGroup label={intl.formatMessage({ id: 'skills.install.scope' })}>
          <div className="flex gap-1.5">
            <ScopeChip
              label={intl.formatMessage({ id: 'skills.scope.global' })}
              active={scope === 'global'}
              onClick={() => {
                setScope('global')
                setDir('.agents/skills')
              }}
            />
            <ScopeChip
              label={intl.formatMessage({ id: 'skills.scope.assistant' })}
              active={scope === 'assistant'}
              onClick={() => {
                setScope('assistant')
                setDir(defaultDirFor(assistantId))
              }}
            />
          </div>
        </FieldGroup>
        {scope === 'assistant' && (
          <Field label={intl.formatMessage({ id: 'skills.install.assistant' })}>
            <Select
              value={assistantId}
              onChange={(event) => {
                setAssistantId(event.target.value)
                setDir(defaultDirFor(event.target.value))
              }}
            >
              {assistants.map((assistant) => (
                <option key={assistant.id} value={assistant.id}>
                  {assistant.id}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>
      <div className="mt-3">
        <Field
          label={intl.formatMessage({ id: 'skills.install.dir' })}
          hint={intl.formatMessage({ id: DIR_HINTS[dir] })}
        >
          <Select value={dir} onChange={(event) => setDir(event.target.value as SkillDir)}>
            {SKILL_DIRS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {error !== null && (
        <div className="mt-3">
          <ErrorText message={error} />
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button
          variant="primary"
          disabled={busy || (scope === 'assistant' && assistantId === '')}
          onClick={() => void submit()}
        >
          {intl.formatMessage({ id: 'skills.install.confirm' })}
        </Button>
        <Button onClick={onClose}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
      </div>
    </Modal>
  )
}
