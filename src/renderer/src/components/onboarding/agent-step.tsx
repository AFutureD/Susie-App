import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import type { AgentCliDetection, AgentInfo, AgentProgress } from '../../../../shared/messages'
import { ipc } from '../../lib/ipc'
import { AgentProgressLine, useAgentProgress } from '../agent-progress'
import { Button } from '../form'

// 向导第 5 步（最后一步）：准备 Agent。检测本机 codex/claude CLI——检测到即推荐对应 agent
// （可复用其登录）；安装必须由用户手动点击（复用 agents.install 与进度事件流），
// 不自动安装，「下一步」/「跳过此步」都进完成页。

/** 向导只推荐这两个 agent：codex（内置 provider）与 claude-acp（ACP registry 的 Claude Agent） */
const SUGGESTED = [
  { agentId: 'codex', fallbackName: 'Codex', cli: 'codex' },
  { agentId: 'claude-acp', fallbackName: 'Claude Agent', cli: 'claude' },
] as const satisfies readonly { agentId: string; fallbackName: string; cli: keyof AgentCliDetection }[]

export function AgentStep({ onNext }: { onNext: () => void }) {
  const intl = useIntl()
  const [detection, setDetection] = useState<AgentCliDetection | null>(null)
  const [overview, setOverview] = useState<AgentInfo[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  // overview 依赖 ACP registry（网络），失败退空列表——行内以「安装源暂不可用」提示
  const refresh = () => {
    void ipc.agents
      .overview()
      .then(setOverview)
      .catch(() => setOverview([]))
  }

  const { progress, fail } = useAgentProgress(refresh)

  useEffect(() => {
    refresh()
    void ipc.agents.detectCli().then(setDetection)
  }, [])

  const install = async (id: string) => {
    setBusyId(id)
    const result = await ipc.agents.install({ id })
    setBusyId(null)
    if (!result.ok) fail(id, result.message)
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'onboarding.step.agent' })}</h2>
        <p className="mt-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'onboarding.agent.subtitle' })}</p>
      </div>

      {overview === null || detection === null ? (
        <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'common.loading' })}</p>
      ) : (
        SUGGESTED.map((item) => (
          <SuggestedAgentRow
            key={item.agentId}
            fallbackName={item.fallbackName}
            cli={item.cli}
            cliPath={detection[item.cli]}
            agent={overview.find((agent) => agent.id === item.agentId)}
            busy={busyId === item.agentId}
            progress={progress[item.agentId]}
            onInstall={() => void install(item.agentId)}
          />
        ))
      )}

      <p className="text-xs leading-5 text-ink-muted/70">{intl.formatMessage({ id: 'onboarding.agent.hint' })}</p>
      <div>
        <Button variant="primary" onClick={onNext}>
          {intl.formatMessage({ id: 'onboarding.agent.next' })}
        </Button>
      </div>
    </section>
  )
}

function SuggestedAgentRow({
  fallbackName,
  cli,
  cliPath,
  agent,
  busy,
  progress,
  onInstall,
}: {
  fallbackName: string
  cli: string
  cliPath: string | null
  agent: AgentInfo | undefined
  busy: boolean
  progress: AgentProgress | undefined
  onInstall: () => void
}) {
  const intl = useIntl()
  // PATH 来源也算可用（如 codex CLI 本身就在 PATH 上），不再重复推荐安装
  const available = agent !== undefined && agent.source !== null

  const statusText = () => {
    switch (agent?.source) {
      case 'installed':
        return intl.formatMessage({ id: 'agents.status.installed' }, { version: agent.installedVersion ?? '?' })
      case 'path':
        return intl.formatMessage({ id: 'agents.status.path' }, { version: agent.installedVersion ?? '?' })
      default:
        return intl.formatMessage(
          { id: cliPath !== null ? 'onboarding.agent.cli.found' : 'onboarding.agent.cli.missing' },
          { cli },
        )
    }
  }

  return (
    <div className="rounded-xl border border-line bg-raised p-4">
      <div className="flex items-center gap-3">
        <span className={`size-2.5 shrink-0 rounded-full ${available ? 'bg-emerald-500' : 'bg-neutral-400'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{agent?.name ?? fallbackName}</span>
            {!available && cliPath !== null && (
              <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                {intl.formatMessage({ id: 'onboarding.agent.recommended' })}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-ink-muted">{statusText()}</div>
          {agent === undefined && (
            <div className="mt-0.5 text-xs text-amber-600">
              {intl.formatMessage({ id: 'onboarding.agent.unavailable' })}
            </div>
          )}
        </div>

        {!available && agent !== undefined && (
          <Button variant="primary" disabled={!agent.installable || busy} onClick={onInstall}>
            {busy ? intl.formatMessage({ id: 'agents.installing' }) : intl.formatMessage({ id: 'agents.install' })}
          </Button>
        )}
      </div>
      {progress !== undefined && <AgentProgressLine progress={progress} />}
    </div>
  )
}
