import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { ConfigState } from '../../../../shared/config'
import type { ManagedBotDiscovery } from '../../../../shared/messages'
import { Button, ErrorText, Field, FieldGroup } from '../../components/form'
import { ipc, useIpcEvent } from '../../lib/ipc'
import { managerStatusesAtom } from '../../lib/service-atoms'

// 「添加托管 Bot」弹窗：tg:// deeplink 去 Telegram 一键创建 → manager 常驻轮询收到
// managed_bot 事件 → 发现实时出现在下方列表 → 点「添加」落地为渠道并关闭窗口（发现 ≠ 添加）。

// username 固定形态 susie_<核心>_bot：用户只填核心段。
// Telegram 约束总长 5–32、字母开头、字母/数字/下划线——前后缀占 10 字符，核心 ≤22。
const USERNAME_PREFIX = 'susie_'
const USERNAME_SUFFIX = '_bot'

function coreValid(core: string): boolean {
  return /^[A-Za-z0-9_]{1,22}$/.test(core)
}

export function AddManagedBotModal({
  state,
  managerId,
  onClose,
}: {
  state: ConfigState
  managerId: string
  onClose: () => void
}) {
  const intl = useIntl()
  const managerStatuses = useAtomValue(managerStatusesAtom)
  const status = managerStatuses.find((item) => item.id === managerId)

  const [core, setCore] = useState('')
  const [name, setName] = useState('')
  const [managerUsername, setManagerUsername] = useState<string | null>(null)
  const [discoveries, setDiscoveries] = useState<ManagedBotDiscovery[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyBotId, setBusyBotId] = useState<string | null>(null)

  const username = `${USERNAME_PREFIX}${core.trim()}${USERNAME_SUFFIX}`
  const canCreate =
    managerUsername !== null && coreValid(core.trim()) && name.trim() !== ''
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
    void ipc.app.openExternal({
      url: `tg://newbot?manager=${managerUsername}&username=${username}&name=${encodeURIComponent(name.trim())}`,
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
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[26rem] flex-col gap-4 overflow-y-auto rounded-xl border border-line bg-raised p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <h3 className="text-base font-semibold">{intl.formatMessage({ id: 'managedBot.title' })}</h3>
          <p className="mt-1 text-xs leading-5 text-ink-muted">{intl.formatMessage({ id: 'managedBot.subtitle' })}</p>
        </div>

        {status !== undefined && status.state !== 'running' && (
          <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-600">
            {intl.formatMessage({ id: 'managedBot.managerNotRunning' }, { detail: status.detail ?? status.state })}
          </div>
        )}

        <div className="flex flex-col gap-3">
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
          <Field label={intl.formatMessage({ id: 'managedBot.field.name' })}>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="My Shiny Bot"
              className="w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent/60"
            />
          </Field>
        </div>

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
        <button
          type="button"
          onClick={onClose}
          className="self-start text-xs text-ink-muted underline-offset-2 hover:underline"
        >
          {intl.formatMessage({ id: 'managedBot.manualFallback' })}
        </button>
      </div>
    </div>
  )
}
