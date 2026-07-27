import { useState } from 'react'
import { useIntl } from 'react-intl'
import { filterSkills, type SkillEntry } from '../../../shared/skills'
import { ipc } from '../lib/ipc'
import { useIpcQuery } from '../lib/ipc-query'
import { Button, TextInput } from './form'
import { Modal } from './modal'

/**
 * 助手可用技能弹窗：只列该 agent 能读取的技能（main 侧按 skillDirsForAgent 过滤——
 * 如 claude 不显示 .agents/skills 中的），工作目录/全局分组只读展示。
 */
export function AssistantSkillsModal({ assistantId, onClose }: { assistantId: string; onClose: () => void }) {
  const intl = useIntl()
  const [query, setQuery] = useState('')
  const { data, loading, error } = useIpcQuery(
    `skills.forAssistant:${assistantId}`,
    () => ipc.skills.listForAssistant({ id: assistantId }),
    { invalidateOn: ['config.state'] },
  )

  const workspace = filterSkills(data?.workspace ?? [], query)
  const global = filterSkills(data?.global ?? [], query)
  const total = (data?.workspace.length ?? 0) + (data?.global.length ?? 0)

  return (
    <Modal
      title={intl.formatMessage({ id: 'assistants.skills.title' }, { id: assistantId })}
      panelClassName="flex max-h-[70vh] w-[30rem] flex-col p-5"
      onClose={onClose}
    >
      {data !== null && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">{data.agentId}</span>
          {data.dirs.length === 0 ? (
            <span>{intl.formatMessage({ id: 'assistants.skills.noDirs' })}</span>
          ) : (
            data.dirs.map((dir) => (
              <span key={dir} className="rounded bg-line/60 px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
                {dir}
              </span>
            ))
          )}
        </div>
      )}
      <TextInput
        value={query}
        placeholder={intl.formatMessage({ id: 'skills.search' })}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
        {error !== null ? (
          <p className="py-2 text-xs text-red-500">{error}</p>
        ) : data === null && loading ? (
          <p className="py-2 text-xs text-ink-muted">{intl.formatMessage({ id: 'common.loading' })}</p>
        ) : total === 0 ? (
          <p className="py-2 text-xs text-ink-muted">{intl.formatMessage({ id: 'assistants.skills.empty' })}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <SkillGroup
              label={intl.formatMessage({ id: 'assistants.skills.workspace' }, { path: data?.workDir ?? '' })}
              entries={workspace}
            />
            <SkillGroup label={intl.formatMessage({ id: 'assistants.skills.global' })} entries={global} />
          </div>
        )}
      </div>
      <div className="mt-3 flex justify-end border-t border-line pt-3">
        <Button onClick={onClose}>{intl.formatMessage({ id: 'assistants.skills.close' })}</Button>
      </div>
    </Modal>
  )
}

function SkillGroup({ label, entries }: { label: string; entries: SkillEntry[] }) {
  const intl = useIntl()
  if (entries.length === 0) return null
  return (
    <div>
      <p className="mb-1.5 truncate text-xs font-medium text-ink-muted">{label}</p>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <div key={`${entry.dir}/${entry.dirName}`} className="rounded-lg border border-line bg-surface px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{entry.name}</span>
              <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] text-accent">{entry.dir}</span>
              {entry.error !== null && (
                <span
                  title={entry.error}
                  className="rounded bg-red-500/10 px-1.5 py-0.5 text-[11px] font-medium text-red-500"
                >
                  {intl.formatMessage({ id: 'skills.entry.error' })}
                </span>
              )}
            </div>
            {entry.description !== '' && <p className="mt-0.5 truncate text-xs text-ink-muted">{entry.description}</p>}
          </div>
        ))}
      </div>
    </div>
  )
}
