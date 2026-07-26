import { useCallback, useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc } from '../../lib/ipc'
import { ONBOARDING_DONE_KEY, onboardingStepFor } from './model'
import { BindingStep } from './binding-step'
import { ChannelStep, DoneStep, OwnerStep } from './steps'

// 首启引导：三步（添加频道 → 绑定 owner → 会话绑定），把「频道页 + 用户管理 + 会话绑定面板」
// 的最小路径串起来。config 仍是唯一事实源：向导所有写操作走既有 IPC，界面随 config:state 广播重派生。
// 完成/跳过后写 localStorage 标记，之后不再出现。

type WizardStep = 'pending' | 'channel' | 'owner' | 'binding' | 'done' | 'closed'

export function OnboardingOverlay() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [step, setStep] = useState<WizardStep>('pending')
  const [channelId, setChannelId] = useState<string | null>(null)
  const [botUsername, setBotUsername] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)

  // 首次拿到配置时决定是否进入向导；此后步骤只由向导内部推进
  useEffect(() => {
    if (step !== 'pending' || state === null) return
    const done = localStorage.getItem(ONBOARDING_DONE_KEY) !== null
    const next = onboardingStepFor(state, done)
    if (next === null) {
      // 配置已成形（如手写 config.toml）→ 补标记，避免以后清空绑定时误弹
      if (!done && state.lastError === null) localStorage.setItem(ONBOARDING_DONE_KEY, '1')
      setStep('closed')
      return
    }
    if (next !== 'channel') setChannelId(Object.keys(state.config.channels)[0] ?? null)
    setStep(next)
  }, [step, state])

  // owner/绑定步需要 bot 深链；引导中途退出后恢复时，用已存 token 反查 username
  useEffect(() => {
    if ((step !== 'owner' && step !== 'binding') || botUsername !== null || channelId === null || state === null) return
    const settings = state.config.channels[channelId]
    if (settings === undefined) return
    let alive = true
    void ipc.channels.resolveUsername({ token: settings.token }).then((result) => {
      if (!alive) return
      if (result.ok) setBotUsername(result.username)
      else setLinkError(result.message)
    })
    return () => {
      alive = false
    }
  }, [step, botUsername, channelId, state])

  const finish = useCallback((): void => {
    localStorage.setItem(ONBOARDING_DONE_KEY, '1')
    setStep('closed')
  }, [])

  if (step === 'pending' || step === 'closed' || state === null) return null

  // 频道在引导期间被外部删除 → 退回第 1 步
  const channelReady = channelId !== null && channelId in state.config.channels
  const effectiveStep = (step === 'owner' || step === 'binding') && !channelReady ? 'channel' : step

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <header className="app-drag h-12 shrink-0" />
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-8 pb-10">
        <div className="w-full max-w-xl">
          <div className="mb-6">
            <h1 className="text-xl font-semibold">{intl.formatMessage({ id: 'onboarding.welcome.title' })}</h1>
            <p className="mt-1 text-sm text-ink-muted">{intl.formatMessage({ id: 'onboarding.welcome.subtitle' })}</p>
          </div>

          {effectiveStep === 'channel' && (
            <ChannelStep
              state={state}
              onCreated={(id, username) => {
                setChannelId(id)
                setBotUsername(username)
                setStep('owner')
              }}
            />
          )}
          {effectiveStep === 'owner' && channelId !== null && (
            <OwnerStep
              state={state}
              channelId={channelId}
              botUsername={botUsername}
              linkError={linkError}
              onBound={() => setStep('binding')}
            />
          )}
          {effectiveStep === 'binding' && channelId !== null && (
            <BindingStep
              state={state}
              channelId={channelId}
              botUsername={botUsername}
              linkError={linkError}
              onFinish={() => setStep('done')}
            />
          )}
          {effectiveStep === 'done' && <DoneStep onClose={finish} />}

          {effectiveStep !== 'done' && (
            <div className="mt-8">
              <button
                type="button"
                onClick={finish}
                className="text-xs text-ink-muted underline-offset-2 hover:underline"
              >
                {intl.formatMessage({ id: 'onboarding.skip' })}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- 第 1 步：添加频道（只填 token） ----------
