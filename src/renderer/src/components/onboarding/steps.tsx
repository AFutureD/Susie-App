import { useState } from 'react'
import { useIntl } from 'react-intl'
import type { ConfigState } from '../../../../shared/config'
import { ipc } from '../../lib/ipc'
import { tgResolveLink } from '../../lib/telegram'
import { Button, ErrorText, Field, TextInput } from '../form'
import { ManagedBotCreatePanel } from '../managed-bot-create'
import { OwnerBindPanel } from '../owner-bind'
import managerDemoVideo from '../../assets/onboarding-manager-bot.mp4'

// 向导第 1/2/3 步与完成页（第 4 步会话绑定在 binding-step.tsx，第 5 步准备 agent 在 agent-step.tsx）。

// ---------- 第 1 步：添加 Manager Bot ----------

export function ManagerStep({
  state,
  onCreated,
}: {
  state: ConfigState
  onCreated: (managerId: string, username: string) => void
}) {
  const intl = useIntl()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const trimmed = token.trim()
    // 用 token 问 getMe：既校验 token，又拿 username 作 manager ID 与深链
    const resolved = await ipc.channels.resolveUsername({ token: trimmed })
    if (!resolved.ok) {
      setBusy(false)
      setError(intl.formatMessage({ id: 'channels.resolve.failed' }, { detail: resolved.message }))
      return
    }
    // 引导第 1 步要的是 manager：必须已在 BotFather 开启 Bot Management Mode
    if (!resolved.canManageBots) {
      setBusy(false)
      setError(intl.formatMessage({ id: 'onboarding.manager.notManager' }))
      return
    }
    const result = await ipc.config.upsertManagerBot({
      id: resolved.username,
      settings: { token: trimmed, managing: [] },
      expectedVersion: state.version,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onCreated(resolved.username, resolved.username)
  }

  return (
    <section className="rounded-xl border border-line bg-raised p-5">
      <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'onboarding.step.manager' })}</h2>
      <div className="mt-3 flex gap-6">
        <div className="min-w-0 flex-1">
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm leading-6 text-ink-muted">
            <li>{intl.formatMessage({ id: 'onboarding.manager.guide.step1' })}</li>
            <li>{intl.formatMessage({ id: 'onboarding.manager.guide.step2' })}</li>
          </ol>
          <div className="mt-3">
            <Button onClick={() => void ipc.app.openExternal({ url: tgResolveLink('BotFather') })}>
              {intl.formatMessage({ id: 'onboarding.manager.guide.open' })}
            </Button>
          </div>

          <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4">
            <Field label={intl.formatMessage({ id: 'channels.field.token' })}>
              <TextInput
                value={token}
                autoFocus
                placeholder="123456:bot-token"
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>
            <ErrorText message={error} />
            <div>
              <Button variant="primary" disabled={busy || token.trim() === ''} onClick={() => void submit()}>
                {intl.formatMessage({ id: busy ? 'onboarding.manager.connecting' : 'onboarding.manager.submit' })}
              </Button>
            </div>
          </div>
        </div>

        {/* Bot Management Mode 开启过程的示范录屏（竖屏），随包分发 */}
        <video
          src={managerDemoVideo}
          className="w-52 shrink-0 self-start rounded-lg border border-line"
          autoPlay
          loop
          muted
          playsInline
          controls
        />
      </div>
    </section>
  )
}

// ---------- 第 2 步：绑定 Owner（绑到 manager；后续托管 bot 的 owner 默认继承它） ----------

export function OwnerStep({
  state,
  managerId,
  managerUsername,
  onBound,
}: {
  state: ConfigState
  managerId: string
  managerUsername: string | null
  onBound: () => void
}) {
  const intl = useIntl()
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'onboarding.step.owner' })}</h2>
        <p className="mt-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'ownerBind.subtitle' })}</p>
        <p className="mt-0.5 text-xs text-ink-muted">{intl.formatMessage({ id: 'onboarding.owner.managerNote' })}</p>
      </div>
      <div className="rounded-xl border border-line bg-raised p-4">
        {/* 向导路径的 managerUsername 恒来自 ManagerStep 的成功解析，不存在深链失败态 */}
        <OwnerBindPanel
          state={state}
          channelId={managerId}
          botUsername={managerUsername}
          linkError={null}
          onBound={onBound}
        />
      </div>
    </section>
  )
}

// ---------- 第 3 步：用 Manager 添加普通 Bot ----------

export function BotStep({
  state,
  managerId,
  onCreated,
}: {
  state: ConfigState
  managerId: string
  onCreated: (channelId: string, username: string) => void
}) {
  const intl = useIntl()
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'onboarding.step.bot' })}</h2>
        <p className="mt-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'onboarding.bot.subtitle' })}</p>
      </div>
      <div className="rounded-xl border border-line bg-raised p-4">
        <ManagedBotCreatePanel state={state} managerId={managerId} onAdded={onCreated} />
      </div>
    </section>
  )
}

// ---------- 完成页 ----------

export function DoneStep({ onClose }: { onClose: () => void }) {
  const intl = useIntl()
  return (
    <section className="rounded-xl border border-line bg-raised p-6 text-center">
      <div className="text-3xl">🎉</div>
      <h2 className="mt-2 text-base font-semibold">{intl.formatMessage({ id: 'onboarding.done.title' })}</h2>
      <p className="mt-2 text-sm leading-6 text-ink-muted">{intl.formatMessage({ id: 'onboarding.done.desc' })}</p>
      <div className="mt-5">
        <Button variant="primary" onClick={onClose}>
          {intl.formatMessage({ id: 'onboarding.done.cta' })}
        </Button>
      </div>
    </section>
  )
}
