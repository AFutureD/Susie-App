import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import type { AgentsOverview } from '../../../shared/messages'
import { Button } from '../components/form'
import { Page } from '../components/page'
import { susie } from '../lib/ipc'

export function AgentsPage() {
  const intl = useIntl()
  const [overview, setOverview] = useState<AgentsOverview | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)

  const refresh = () => {
    void susie.invoke('agents:overview').then(setOverview)
  }

  useEffect(() => {
    refresh()
    const off = susie.on('agents:progress', (event) => {
      const phaseText: Record<string, string> = {
        downloading: '下载中',
        extracting: '解压中',
        done: '完成',
        error: '失败',
      }
      setProgress(
        `${event.id}: ${phaseText[event.phase] ?? event.phase}${event.detail !== null ? ` — ${event.detail}` : ''}`,
      )
      if (event.phase === 'done' || event.phase === 'error') refresh()
    })
    return off
  }, [])

  const install = async (id: string) => {
    setBusyId(id)
    const result = await susie.invoke('agents:install', { id })
    setBusyId(null)
    if (!result.ok) window.alert(result.message)
  }

  const uninstall = async (id: string) => {
    if (!window.confirm(intl.formatMessage({ id: 'agents.uninstallConfirm' }, { id }))) return
    const result = await susie.invoke('agents:uninstall', { id })
    if (!result.ok) window.alert(result.message)
    refresh()
  }

  return (
    <Page titleId="page.agents.title">
      <section className="mb-6 rounded-xl border border-line bg-raised p-5">
        <div className="flex items-center gap-3">
          <span
            className={`size-2.5 rounded-full ${overview?.codex.available ? 'bg-emerald-500' : 'bg-neutral-400'}`}
          />
          <div className="flex-1">
            <div className="text-sm font-semibold">Codex</div>
            <div className="mt-0.5 text-xs text-ink-muted">
              {overview === null
                ? intl.formatMessage({ id: 'common.loading' })
                : overview.codex.available
                  ? intl.formatMessage({ id: 'agents.codex.ready' }, { version: overview.codex.version ?? '?' })
                  : intl.formatMessage({ id: 'agents.codex.missing' })}
            </div>
          </div>
          <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
            agent_id: codex
          </span>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{intl.formatMessage({ id: 'agents.acp.title' })}</h2>
          <Button onClick={refresh}>{intl.formatMessage({ id: 'agents.refresh' })}</Button>
        </div>
        {progress !== null && (
          <p className="mb-3 rounded-md bg-accent/10 px-3 py-2 font-mono text-xs text-accent">{progress}</p>
        )}
        <div className="flex flex-col gap-2">
          {overview === null && (
            <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'common.loading' })}</p>
          )}
          {overview !== null && overview.acp.length === 0 && (
            <p className="rounded-xl border border-dashed border-line p-5 text-xs text-ink-muted">
              {intl.formatMessage({ id: 'agents.acp.empty' })}
            </p>
          )}
          {overview?.acp.map((agent) => (
            <div key={agent.id} className="flex items-center gap-3 rounded-xl border border-line bg-raised p-4">
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
          ))}
        </div>
      </section>
    </Page>
  )
}
