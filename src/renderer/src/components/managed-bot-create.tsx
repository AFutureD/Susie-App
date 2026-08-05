import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { ConfigState } from '../../../shared/config'
import type { ManagedBotDiscovery } from '../../../shared/messages'
import { ipc, useIpcEvent } from '../lib/ipc'
import { managerStatusesAtom } from '../lib/service-atoms'
import { Button, ErrorText, FieldGroup } from './form'

// 「用 Manager 创建托管 Bot」面板：tg:// deeplink 去 Telegram 一键创建 → manager 常驻轮询收到
// managed_bot 事件 → 发现实时出现在下方列表 → 点「添加」落地为渠道（发现 ≠ 添加）。
// 渠道页「添加托管 Bot」弹窗与 onboarding「添加 Bot」步共用；新渠道的 owner 由主进程
// addManagedBot 自动继承 manager 的 owner（创建者兜底）。

// username 固定形态 susie_<核心>_bot：用户只填核心段。
// Telegram 约束总长 5–32、字母开头、字母/数字/下划线——前后缀占 10 字符，核心 ≤22。
const USERNAME_PREFIX = 'susie_'
const USERNAME_SUFFIX = '_bot'

function coreValid(core: string): boolean {
  return /^[A-Za-z0-9_]{1,22}$/.test(core)
}

export function ManagedBotCreatePanel({
  state,
  managerId,
  onAdded,
}: {
  state: ConfigState
  managerId: string
  /** 发现落地为渠道后回调（channelId = bot username） */
  onAdded: (channelId: string, username: string) => void
}) {
  const intl = useIntl()
  const managerStatuses = useAtomValue(managerStatusesAtom)
  const status = managerStatuses.find((item) => item.id === managerId)

  const [core, setCore] = useState('')
  const [managerUsername, setManagerUsername] = useState<string | null>(null)
  const [discoveries, setDiscoveries] = useState<ManagedBotDiscovery[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyBotId, setBusyBotId] = useState<string | null>(null)

  const username = `${USERNAME_PREFIX}${core.trim()}${USERNAME_SUFFIX}`
  const canCreate = managerUsername !== null && coreValid(core.trim())
  const managerToken = state.config.manager_bots[managerId]?.token

  // deeplink 必须用 manager 的真实 username（配置里的 id 允许自定义，不可直接用）
  useEffect(() => {
    if (managerToken === undefined) return
    let alive = true
    void ipc.channels.resolveUsername({ token: managerToken }).then((result) => {
      if (!alive) return
      if (result.ok) setManagerUsername(result.username)
      else setError(intl.formatMessage({ id: 'channels.resolve.failed' }, { detail: result.message }))
    })
    return () => {
      alive = false
    }
  }, [managerToken, intl])

  useEffect(() => {
    let alive = true
    void ipc.managerBots.discoveries({ managerId }).then((list) => {
      if (alive) setDiscoveries(list)
    })
    return () => {
      alive = false
    }
  }, [managerId])

  useIpcEvent('managerBots.discoveries', (payload) => {
    if (payload.managerId === managerId) setDiscoveries(payload.discoveries)
  })

  const openTelegram = () => {
    if (!canCreate || managerUsername === null) return
    // 显示名称不再单独收集，直接沿用 username；创建后可在 BotFather 里改
    void ipc.app.openExternal({
      url: `tg://newbot?manager=${managerUsername}&username=${username}&name=${encodeURIComponent(username)}`,
    })
  }

  const add = async (discovery: ManagedBotDiscovery) => {
    setBusyBotId(discovery.botId)
    setError(null)
    const result = await ipc.managerBots.add({
      managerId,
      botId: discovery.botId,
      expectedVersion: state.version,
    })
    setBusyBotId(null)
    if (!result.ok) {
      setError(result.conflict ? intl.formatMessage({ id: 'bindings.error.conflictRefreshed' }) : result.message)
      return
    }
    onAdded(result.channelId, discovery.username)
  }

  return (
    <div className="flex flex-col gap-4">
      {status !== undefined && status.state !== 'running' && (
        <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-600">
          {intl.formatMessage({ id: 'managedBot.managerNotRunning' }, { detail: status.detail ?? status.state })}
        </div>
      )}

      <FieldGroup
        label={intl.formatMessage({ id: 'managedBot.field.username' })}
        hint={intl.formatMessage({ id: 'managedBot.field.username.hint' })}
      >
        <div className="flex items-center rounded-md border border-line bg-surface focus-within:border-accent/60">
          <span className="shrink-0 pl-2.5 font-mono text-sm text-ink-muted select-none">{USERNAME_PREFIX}</span>
          <input
            value={core}
            onChange={(event) => setCore(event.target.value)}
            placeholder="shiny"
            className="w-full min-w-0 bg-transparent py-1.5 font-mono text-sm outline-none"
          />
          <span className="shrink-0 pr-2.5 font-mono text-sm text-ink-muted select-none">{USERNAME_SUFFIX}</span>
        </div>
      </FieldGroup>

      <div className="flex items-center gap-3">
        <Button variant="primary" disabled={!canCreate} onClick={openTelegram}>
          {intl.formatMessage({ id: 'managedBot.create' })}
        </Button>
        {core.trim() !== '' && coreValid(core.trim()) && (
          <span className="truncate font-mono text-xs text-ink-muted select-text">@{username}</span>
        )}
      </div>

      <div className="rounded-lg border border-line">
        {discoveries.length === 0 ? (
          <div className="flex items-center gap-2 p-4 text-sm text-ink-muted">
            <span className="size-2 animate-pulse rounded-full bg-amber-500" />
            {intl.formatMessage({ id: 'managedBot.waiting' })}
          </div>
        ) : (
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto p-2">
            {discoveries.map((discovery) => (
              <div key={discovery.botId} className="flex items-center gap-3 rounded-md px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">
                    {discovery.name} <span className="font-mono text-xs text-ink-muted">@{discovery.username}</span>
                  </div>
                  <div className="truncate text-xs text-ink-muted">
                    {intl.formatMessage(
                      { id: 'managedBot.creator' },
                      { name: discovery.creatorName ?? discovery.creatorId },
                    )}
                  </div>
                </div>
                <Button disabled={busyBotId !== null} onClick={() => void add(discovery)}>
                  {intl.formatMessage({ id: 'managedBot.add' })}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ErrorText message={error} />
    </div>
  )
}
