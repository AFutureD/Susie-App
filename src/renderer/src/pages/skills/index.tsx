import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { filterSkills, type SkillEntry, type SkillScope } from '../../../../shared/skills'
import { Button, ErrorText, Select, TextInput } from '../../components/form'
import { Page, PlaceholderCard } from '../../components/page'
import { assistantLabel } from '../../lib/assistant-label'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc } from '../../lib/ipc'
import { useIpcQuery } from '../../lib/ipc-query'
import { toast } from '../../lib/toast'
import { SkillsAcquireModal } from './remote'

// 技能页（本地管理）：一级维度 全局/助手，二级列表 + 客户端搜索。
// 每行必显所在容器目录徽标；不展示 symlink 等文件系统细节（用户拍板）。

export function SkillsPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [scope, setScope] = useState<SkillScope>('global')
  const [assistantId, setAssistantId] = useState('')
  const [query, setQuery] = useState('')
  const [acquireOpen, setAcquireOpen] = useState(false)

  // 助手维度默认取第一个助手；选中的助手被删除后同样回落
  const assistants = state?.config.assistants ?? []
  const effectiveAssistant =
    assistantId !== '' && assistants.some((assistant) => assistant.id === assistantId)
      ? assistantId
      : (assistants[0]?.id ?? '')
  const enabled = state !== null && (scope === 'global' || effectiveAssistant !== '')
  const local = useIpcQuery(
    `skills.local:${scope}:${scope === 'assistant' ? effectiveAssistant : ''}`,
    () => ipc.skills.listLocal({ scope, ...(scope === 'assistant' ? { assistantId: effectiveAssistant } : {}) }),
    { enabled },
  )

  if (!state) {
    return <Page titleId="page.skills.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  const removeSkill = async (skill: SkillEntry) => {
    const confirmed = window.confirm(
      intl.formatMessage({ id: 'skills.deleteConfirm' }, { name: skill.name, path: skill.path }),
    )
    if (!confirmed) return
    const result = await ipc.skills.remove({
      scope,
      ...(scope === 'assistant' ? { assistantId: effectiveAssistant } : {}),
      dir: skill.dir,
      dirName: skill.dirName,
    })
    if (!result.ok) {
      toast(result.message, 'error')
      return
    }
    local.refetch()
  }

  const reveal = async (skill: SkillEntry) => {
    const result = await ipc.skills.reveal({ path: skill.path })
    if (!result.ok) toast(result.message, 'error')
  }

  const skills = local.data?.skills ?? []
  const filtered = filterSkills(skills, query)

  return (
    <Page
      titleId="page.skills.title"
      actions={
        <div className="flex gap-2">
          <Button onClick={() => setAcquireOpen(true)}>{intl.formatMessage({ id: 'skills.remote.open' })}</Button>
          <Button onClick={() => local.refetch()}>{intl.formatMessage({ id: 'skills.refresh' })}</Button>
        </div>
      }
    >
      <div className="mb-4 flex items-center gap-2">
        <ScopeChip
          label={intl.formatMessage({ id: 'skills.scope.global' })}
          active={scope === 'global'}
          onClick={() => setScope('global')}
        />
        <ScopeChip
          label={intl.formatMessage({ id: 'skills.scope.assistant' })}
          active={scope === 'assistant'}
          onClick={() => setScope('assistant')}
        />
        {scope === 'assistant' && assistants.length > 0 && (
          <div className="w-44 shrink-0">
            <Select value={effectiveAssistant} onChange={(event) => setAssistantId(event.target.value)}>
              {assistants.map((assistant) => (
                <option key={assistant.id} value={assistant.id}>
                  {assistantLabel(assistant)}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="min-w-0 flex-1">
          <TextInput
            value={query}
            placeholder={intl.formatMessage({ id: 'skills.search' })}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {scope === 'assistant' && assistants.length === 0 ? (
        <PlaceholderCard messageId="skills.assistant.none" />
      ) : (
        <>
          {local.data !== null && (
            <p className="mb-3 truncate font-mono text-xs text-ink-muted">
              {intl.formatMessage({ id: 'skills.root' }, { path: local.data.root })}
            </p>
          )}
          <ErrorText message={local.error} />
          {local.data === null && local.error === null ? (
            <p className="text-sm text-ink-muted">{intl.formatMessage({ id: 'common.loading' })}</p>
          ) : skills.length === 0 ? (
            <PlaceholderCard messageId="skills.empty" />
          ) : filtered.length === 0 ? (
            <p className="text-sm text-ink-muted">{intl.formatMessage({ id: 'skills.noMatch' })}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {filtered.map((skill) => (
                <div key={`${skill.dir}/${skill.dirName}`} className="rounded-xl border border-line bg-raised p-4">
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold">{skill.name}</span>
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent">
                          {skill.dir}
                        </span>
                        {skill.error !== null && (
                          <span
                            title={skill.error}
                            className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-500"
                          >
                            {intl.formatMessage({ id: 'skills.entry.error' })}
                          </span>
                        )}
                      </div>
                      {skill.description !== '' && (
                        <p className="mt-1 truncate text-xs text-ink-muted">{skill.description}</p>
                      )}
                    </div>
                    <Button onClick={() => void reveal(skill)}>{intl.formatMessage({ id: 'skills.reveal' })}</Button>
                    <Button variant="danger" onClick={() => void removeSkill(skill)}>
                      {intl.formatMessage({ id: 'common.delete' })}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {acquireOpen && <SkillsAcquireModal onClose={() => setAcquireOpen(false)} onInstalled={() => local.refetch()} />}
    </Page>
  )
}

/** 维度切换 chip（样式对位 schedule-editor 的 ToggleChip）；获取页的安装弹窗复用 */
export function ScopeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-accent text-white' : 'border border-line text-ink-muted hover:text-ink'
      }`}
    >
      {label}
    </button>
  )
}
