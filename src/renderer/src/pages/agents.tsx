import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import type { AgentInfo, AgentProgress, AgentsOverview } from '../../../shared/messages'
import { AgentProgressLine, useAgentProgress } from '../components/agent-progress'
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
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { Page } from '../components/page'
import { ipc } from '../lib/ipc'
import { toast } from '@/components/ui/toast'

export function AgentsPage() {
  const intl = useIntl()
  const [overview, setOverview] = useState<AgentsOverview | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [uninstallId, setUninstallId] = useState<string | null>(null)

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
    setUninstallId(null)
    const result = await ipc.agents.uninstall({ id })
    if (!result.ok) toast.add({ title: result.message, type: 'error' })
    refresh()
  }

  return (
    <Page titleId="page.agents.title">
      <div className="mb-3 flex items-center justify-end">
        <Button variant="outline" onClick={refresh}>
          {intl.formatMessage({ id: 'agents.refresh' })}
        </Button>
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
            onUninstall={() => setUninstallId(agent.id)}
          />
        ))}
        {overview !== null && overview.every((agent) => agent.source === null || agent.id === 'codex') && (
          <Empty>
            <EmptyDescription>{intl.formatMessage({ id: 'agents.acp.empty' })}</EmptyDescription>
          </Empty>
        )}
      </div>
      <AlertDialog
        open={uninstallId !== null}
        onOpenChange={(open) => {
          if (!open) setUninstallId(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{intl.formatMessage({ id: 'agents.uninstall' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({ id: 'agents.uninstallConfirm' }, { id: uninstallId ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{intl.formatMessage({ id: 'common.cancel' })}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (uninstallId !== null) void uninstall(uninstallId)
              }}
            >
              {intl.formatMessage({ id: 'agents.uninstall' })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
            <Badge variant="secondary">{agent.id}</Badge>
            {agent.latestVersion !== null && (
              <span className="font-mono text-[11px] text-ink-muted">v{agent.latestVersion}</span>
            )}
            {available && agent.mcpHttp === false && (
              <Badge variant="outline" title={intl.formatMessage({ id: 'agents.mcpUnsupported.hint' })}>
                {intl.formatMessage({ id: 'agents.mcpUnsupported' })}
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">{statusText()}</div>
          {agent.description !== '' && <p className="mt-0.5 truncate text-xs text-ink-muted">{agent.description}</p>}
        </div>

        {!available && (
          <Button disabled={!agent.installable || busy} onClick={onInstall}>
            {busy ? intl.formatMessage({ id: 'agents.installing' }) : intl.formatMessage({ id: 'agents.install' })}
          </Button>
        )}
        {updatable && (
          <Button disabled={busy} onClick={onInstall}>
            {busy ? intl.formatMessage({ id: 'agents.installing' }) : intl.formatMessage({ id: 'agents.update' })}
          </Button>
        )}
        {agent.source === 'installed' && (
          <Button variant="destructive" onClick={onUninstall}>
            {intl.formatMessage({ id: 'agents.uninstall' })}
          </Button>
        )}
      </div>
      {progress !== undefined && <AgentProgressLine progress={progress} />}
    </div>
  )
}
