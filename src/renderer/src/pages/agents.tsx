import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import type { AgentInfo, AgentProgress, AgentsOverview } from '../../../shared/messages'
import { Button } from '../components/form'
import { Page } from '../components/page'
import { ipc, onIpcEvent } from '../lib/ipc'
import { toast } from '../lib/toast'

export function AgentsPage() {
  const intl = useIntl()
  const [overview, setOverview] = useState<AgentsOverview | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState<Record<string, AgentProgress>>({})

  const refresh = () => {
    void ipc.agents.overview().then(setOverview)
  }

  useEffect(() => {
    refresh()
    const off = onIpcEvent('agents.progress', (event) => {
      setProgress((prev) => {
        // 完成即撤掉进度条，刷新后卡片自然切到已安装态
        if (event.phase === 'done') {
          const next = { ...prev }
          delete next[event.id]
          return next
        }
        return { ...prev, [event.id]: event }
      })
      if (event.phase === 'done' || event.phase === 'error') refresh()
    })
    return off
  }, [])

  const install = async (id: string) => {
    setBusyId(id)
    const result = await ipc.agents.install({ id })
    setBusyId(null)
    if (!result.ok) {
      // 兜底：进度事件之前就失败（如 registry 拉取失败）也要在卡片上可见
      setProgress((prev) => ({ ...prev, [id]: { id, phase: 'error', detail: result.message } }))
    }
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
      case 'dev':
        return intl.formatMessage({ id: 'agents.status.dev' }, { version: agent.installedVersion ?? '?' })
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
      {progress !== undefined && <ProgressLine progress={progress} />}
    </div>
  )
}

function formatMB(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`
}

/** 安装进度：下载中显示字节进度条（无 content-length 时为不确定态），解压为不确定态，失败为红字 */
function ProgressLine({ progress }: { progress: AgentProgress }) {
  const intl = useIntl()

  if (progress.phase === 'error') {
    return (
      <p className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-500">
        {intl.formatMessage({ id: 'agents.progress.error' }, { detail: progress.detail ?? '?' })}
      </p>
    )
  }

  const received = progress.received ?? 0
  const total = progress.total ?? null
  const percent =
    progress.phase === 'downloading' && total !== null ? Math.min(100, Math.round((received / total) * 100)) : null

  const label =
    progress.phase === 'downloading'
      ? total !== null
        ? intl.formatMessage(
            { id: 'agents.progress.downloading' },
            { received: formatMB(received), total: formatMB(total), percent: String(percent) },
          )
        : intl.formatMessage({ id: 'agents.progress.downloading.indeterminate' }, { received: formatMB(received) })
      : progress.phase === 'probing'
        ? intl.formatMessage({ id: 'agents.progress.probing' })
        : intl.formatMessage({ id: 'agents.progress.extracting' })

  return (
    <div className="mt-3">
      <div className="text-[11px] text-ink-muted">{label}</div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
        {percent !== null ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
        )}
      </div>
    </div>
  )
}
