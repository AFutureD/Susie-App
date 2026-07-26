import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import type { AgentProgress, AgentsOverview } from '../../../shared/messages'
import { Button } from '../components/form'
import { Page } from '../components/page'
import { ipc, susie } from '../lib/ipc'

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
    const off = susie.on('agents:progress', (event) => {
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
    if (!result.ok) window.alert(result.message)
    refresh()
  }

  const codex = overview?.codex ?? null
  const codexStatusText = () => {
    if (codex === null) return intl.formatMessage({ id: 'common.loading' })
    if (!codex.available) {
      return intl.formatMessage({ id: 'agents.codex.missing' }, { version: codex.targetVersion ?? '?' })
    }
    const sourceId =
      codex.source === 'installed'
        ? 'agents.codex.ready.installed'
        : codex.source === 'dev'
          ? 'agents.codex.ready.dev'
          : 'agents.codex.ready.path'
    return intl.formatMessage({ id: sourceId }, { version: codex.version ?? '?' })
  }

  const uninstallCodex = async () => {
    if (!window.confirm(intl.formatMessage({ id: 'agents.codex.uninstallConfirm' }))) return
    const result = await ipc.agents.uninstall({ id: 'codex' })
    if (!result.ok) window.alert(result.message)
    refresh()
  }

  return (
    <Page titleId="page.agents.title">
      <section className="mb-6 rounded-xl border border-line bg-raised p-5">
        <div className="flex items-center gap-3">
          <span className={`size-2.5 rounded-full ${codex?.available ? 'bg-emerald-500' : 'bg-neutral-400'}`} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">Codex</span>
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                agent_id: codex
              </span>
            </div>
            <div className="mt-0.5 text-xs text-ink-muted">{codexStatusText()}</div>
          </div>
          {codex !== null && !codex.available && (
            <Button
              variant="primary"
              disabled={codex.targetVersion === null || busyId === 'codex'}
              onClick={() => void install('codex')}
            >
              {busyId === 'codex'
                ? intl.formatMessage({ id: 'agents.installing' })
                : intl.formatMessage({ id: 'agents.codex.download' })}
            </Button>
          )}
          {codex?.source === 'installed' && (
            <>
              {codex.targetVersion !== null && codex.targetVersion !== codex.version && (
                <Button variant="primary" disabled={busyId === 'codex'} onClick={() => void install('codex')}>
                  {busyId === 'codex'
                    ? intl.formatMessage({ id: 'agents.installing' })
                    : intl.formatMessage({ id: 'agents.update' })}
                </Button>
              )}
              <Button variant="danger" onClick={() => void uninstallCodex()}>
                {intl.formatMessage({ id: 'agents.uninstall' })}
              </Button>
            </>
          )}
        </div>
        {progress['codex'] !== undefined && <ProgressLine progress={progress['codex']} />}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{intl.formatMessage({ id: 'agents.acp.title' })}</h2>
          <Button onClick={refresh}>{intl.formatMessage({ id: 'agents.refresh' })}</Button>
        </div>
        <div className="flex flex-col gap-2">
          {overview === null && (
            <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'common.loading' })}</p>
          )}
          {overview !== null && overview.acp.length === 0 && (
            <p className="rounded-xl border border-dashed border-line p-5 text-xs text-ink-muted">
              {intl.formatMessage({ id: 'agents.acp.empty' })}
            </p>
          )}
          {overview?.acp.map((agent) => {
            const agentProgress = progress[agent.id]
            return (
              <div key={agent.id} className="rounded-xl border border-line bg-raised p-4">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{agent.name}</span>
                      <span className="font-mono text-[11px] text-ink-muted">
                        {agent.id} · v{agent.version}
                      </span>
                      {agent.installedVersion !== null && (
                        <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-600">
                          {intl.formatMessage({ id: 'agents.installed' }, { version: agent.installedVersion })}
                        </span>
                      )}
                      {agent.installedVersion !== null && agent.mcpHttp === false && (
                        <span
                          className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600"
                          title={intl.formatMessage({ id: 'agents.mcpUnsupported.hint' })}
                        >
                          {intl.formatMessage({ id: 'agents.mcpUnsupported' })}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-ink-muted">{agent.description}</p>
                  </div>
                  {agent.installedVersion === null ? (
                    <Button
                      variant="primary"
                      disabled={!agent.installable || busyId === agent.id}
                      onClick={() => void install(agent.id)}
                    >
                      {busyId === agent.id
                        ? intl.formatMessage({ id: 'agents.installing' })
                        : intl.formatMessage({ id: 'agents.install' })}
                    </Button>
                  ) : (
                    <>
                      {agent.installedVersion !== agent.version && (
                        <Button variant="primary" disabled={busyId === agent.id} onClick={() => void install(agent.id)}>
                          {intl.formatMessage({ id: 'agents.update' })}
                        </Button>
                      )}
                      <Button variant="danger" onClick={() => void uninstall(agent.id)}>
                        {intl.formatMessage({ id: 'agents.uninstall' })}
                      </Button>
                    </>
                  )}
                </div>
                {agentProgress !== undefined && <ProgressLine progress={agentProgress} />}
              </div>
            )
          })}
        </div>
      </section>
    </Page>
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
