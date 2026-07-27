import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { configStateAtom } from '../../lib/config-atoms'
import { shouldOnboard } from './model'
import { AgentStep } from './agent-step'
import { BindingStep } from './binding-step'
import { ChannelStep, DoneStep, OwnerStep } from './steps'

// 首启引导：四步（添加频道 → 绑定 owner → 会话绑定 → 准备 agent），把「频道页 + 用户管理 +
// 会话绑定面板 + Agent 页」的最小路径串起来。进入只看 config.toml 是否存在（shouldOnboard），
// 无 localStorage 标记；步骤推进全在向导内部。config 仍是唯一事实源：向导所有写操作走既有 IPC，
// 界面随 config:state 广播重派生。「跳过引导」在前三步关闭整个向导；agent 步只跳过该步（进完成页）。

type WizardStep = 'pending' | 'channel' | 'owner' | 'binding' | 'agent' | 'done' | 'closed'

export function OnboardingOverlay() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [step, setStep] = useState<WizardStep>('pending')
  const [channelId, setChannelId] = useState<string | null>(null)
  const [botUsername, setBotUsername] = useState<string | null>(null)

  // 首次拿到配置时决定是否进入向导；此后步骤只由向导内部推进
  useEffect(() => {
    if (step !== 'pending' || state === null) return
    setStep(shouldOnboard(state) ? 'channel' : 'closed')
  }, [step, state])

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
              onBound={() => setStep('binding')}
            />
          )}
          {effectiveStep === 'binding' && channelId !== null && (
            <BindingStep
              state={state}
              channelId={channelId}
              botUsername={botUsername}
              onFinish={() => setStep('agent')}
            />
          )}
          {effectiveStep === 'agent' && <AgentStep onNext={() => setStep('done')} />}
          {effectiveStep === 'done' && <DoneStep onClose={() => setStep('closed')} />}

          {effectiveStep !== 'done' && (
            <div className="mt-8">
              {effectiveStep === 'agent' ? (
                // agent 步是最后一步：这里只跳过本步（进完成页），不关闭整个向导
                <button
                  type="button"
                  onClick={() => setStep('done')}
                  className="text-xs text-ink-muted underline-offset-2 hover:underline"
                >
                  {intl.formatMessage({ id: 'onboarding.agent.skip' })}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setStep('closed')}
                  className="text-xs text-ink-muted underline-offset-2 hover:underline"
                >
                  {intl.formatMessage({ id: 'onboarding.skip' })}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
