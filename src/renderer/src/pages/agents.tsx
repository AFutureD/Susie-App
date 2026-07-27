import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import type { AgentInfo, AgentProgress, AgentsOverview } from '../../../shared/messages'
import { AgentProgressLine, useAgentProgress } from '../components/agent-progress'
import { Button } from '../components/form'
import { Page } from '../components/page'
import { ipc } from '../lib/ipc'
import { toast } from '../lib/toast'

export function AgentsPage() {
  const intl = useIntl()
  const [overview, setOverview] = useState<AgentsOverview | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = () => {
    void ipc.agents.overview().then(setOverview)
  }

  const { progress, fail } = useAgentProgress(refresh)

  useEffect(() => {
    refresh()
  }, [])

  const install = async (id: string) => {
    setBusyId(id)
    const result = await ipc.agents.install({ id })
    setBusyId(null)
    if (!result.ok) fail(id, result.message)
  }

  const uninstall = async (id: string) => {
    if (!window.confirm(intl.formatMessage({ id: 'agents.uninstallConfirm' }, { id }))) return
    const result = await ipc.agents.uninstall({ id })
    if (!result.ok) toast(result.message, 'error')
    refresh()
  }

  return (
    <Page titleId="page.agents.title">
      <div className="mb-3 flex items-center justify-end">
        <Button onClick={refresh}>{intl.formatMessage({ id: 'agents.refresh' })}</Button>
      </div>
      <div className="flex flex-col gap-2">
        {overview === null && <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'common.loading' })}</p>}
        {overview?.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            busy={busyId === agent.id}
            progress={progress[agent.id]}
            onInstall={() => void install(agent.id)}
            onUninstall={() => void uninstall(agent.id)}
          />
        ))}
        {overview !== null && overview.every((agent) => agent.source === null || agent.id === 'codex') && (
          <p className="rounded-xl border border-dashed border-line p-5 text-xs text-ink-muted">
            {intl.formatMessage({ id: 'agents.acp.empty' })}
          </p>
        )}
      </div>
    </Page>
  )
}

/** 同构 agent 行：字段驱动（安装态/来源/更新/卸载/MCP 告警），不再按 provider 分块特判 */
function AgentRow({
  agent,
  busy,
  progress,
  onInstall,
  onUninstall,
}: {
  agent: AgentInfo
  busy: boolean
  progress: AgentProgress | undefined
  onInstall: () => void
  onUninstall: () => void
}) {
  const intl = useIntl()
  const available = agent.source !== null

  const statusText = () => {
    switch (agent.source) {
      case 'installed':
        return intl.formatMessage({ id: 'agents.status.installed' }, { version: agent.installedVersion ?? '?' })
      case 'path':
        return intl.formatMessage({ id: 'agents.status.path' }, { version: agent.installedVersion ?? '?' })
      default:
        return intl.formatMessage({ id: 'agents.status.missing' })
    }
  }

  const updatable =
    agent.source === 'installed' && agent.latestVersion !== null && agent.latestVersion !== agent.installedVersion

  return (
    <div className="rounded-xl border border-line bg-raised p-4">
      <div className="flex items-center gap-3">
        <span className={`size-2.5 shrink-0 rounded-full ${available ? 'bg-emerald-500' : 'bg-neutral-400'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{agent.name}</span>
            <span className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-accent">
              {agent.id}
            </span>
            {agent.latestVersion !== null && (
              <span className="font-mono text-[11px] text-ink-muted">v{agent.latestVersion}</span>
            )}
            {available && agent.mcpHttp === false && (
              <span
                className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600"
                title={intl.formatMessage({ id: 'agents.mcpUnsupported.hint' })}
              >
                {intl.formatMessage({ id: 'agents.mcpUnsupported' })}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">{statusText()}</div>
          {agent.description !== '' && <p className="mt-0.5 truncate text-xs text-ink-muted">{agent.description}</p>}
        </div>

        {!available && (
          <Button variant="primary" disabled={!agent.installable || busy} onClick={onInstall}>
            {busy ? intl.formatMessage({ id: 'agents.installing' }) : intl.formatMessage({ id: 'agents.install' })}
          </Button>
        )}
        {updatable && (
          <Button variant="primary" disabled={busy} onClick={onInstall}>
            {busy ? intl.formatMessage({ id: 'agents.installing' }) : intl.formatMessage({ id: 'agents.update' })}
          </Button>
        )}
        {agent.source === 'installed' && (
          <Button variant="danger" onClick={onUninstall}>
            {intl.formatMessage({ id: 'agents.uninstall' })}
          </Button>
        )}
      </div>
      {progress !== undefined && <AgentProgressLine progress={progress} />}
    </div>
  )
}
