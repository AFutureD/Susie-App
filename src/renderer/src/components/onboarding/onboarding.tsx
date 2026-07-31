import { Fragment, useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { configStateAtom } from '../../lib/config-atoms'
import { shouldOnboard } from './model'
import { AgentStep } from './agent-step'
import { BindingStep } from './binding-step'
import { BotStep, DoneStep, ManagerStep, OwnerStep } from './steps'

// 首启引导：五步（添加 Manager Bot → 绑定 owner → 用 Manager 添加 Bot → 会话绑定 → 准备 agent），
// 把「Manager 接入 + 用户管理 + 托管建 bot + 会话绑定面板 + Agent 页」的最小路径串起来。
// owner 绑在 manager 上：之后托管落地的渠道由主进程自动继承 manager 的 owner（创建者兜底）。
// 进入只看 config.toml 是否存在（shouldOnboard），无 localStorage 标记；步骤推进全在向导内部。
// config 仍是唯一事实源：向导所有写操作走既有 IPC，界面随 config:state 广播重派生。
// 「跳过引导」在前四步关闭整个向导；agent 步只跳过该步（进完成页）。

type WizardStep = 'pending' | 'manager' | 'owner' | 'bot' | 'binding' | 'agent' | 'done' | 'closed'

/** 顶部步骤指示器的顺序（done 视为全部完成） */
const STEP_ORDER = ['manager', 'owner', 'bot', 'binding', 'agent'] as const

export function OnboardingOverlay() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [step, setStep] = useState<WizardStep>('pending')
  const [managerId, setManagerId] = useState<string | null>(null)
  const [managerUsername, setManagerUsername] = useState<string | null>(null)
  const [channelId, setChannelId] = useState<string | null>(null)
  const [botUsername, setBotUsername] = useState<string | null>(null)

  // 首次拿到配置时决定是否进入向导；此后步骤只由向导内部推进
  useEffect(() => {
    if (step !== 'pending' || state === null) return
    setStep(shouldOnboard(state) ? 'manager' : 'closed')
  }, [step, state])

  if (step === 'pending' || step === 'closed' || state === null) return null

  // 引导期间依赖对象被外部删除时回退：manager 没了回第 1 步；渠道没了回「添加 Bot」步
  const managerReady = managerId !== null && managerId in state.config.manager_bots
  const channelReady = channelId !== null && channelId in state.config.channels
  let effectiveStep = step
  if ((step === 'owner' || step === 'bot') && !managerReady) effectiveStep = 'manager'
  if (step === 'binding' && !channelReady) effectiveStep = managerReady ? 'bot' : 'manager'

  const stepIndex =
    effectiveStep === 'done' ? STEP_ORDER.length : STEP_ORDER.indexOf(effectiveStep as (typeof STEP_ORDER)[number])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <header className="app-drag h-12 shrink-0" />
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-8 pb-10">
        {/* manager 步右侧带示范视频，容器加宽 */}
        <div className={`w-full ${effectiveStep === 'manager' ? 'max-w-3xl' : 'max-w-xl'}`}>
          <div className="mb-5">
            <h1 className="text-xl font-semibold">{intl.formatMessage({ id: 'onboarding.welcome.title' })}</h1>
            <p className="mt-1 text-sm text-ink-muted">{intl.formatMessage({ id: 'onboarding.welcome.subtitle' })}</p>
          </div>

          <StepIndicator current={stepIndex} />

          {effectiveStep === 'manager' && (
            <ManagerStep
              state={state}
              onCreated={(id, username) => {
                setManagerId(id)
                setManagerUsername(username)
                setStep('owner')
              }}
            />
          )}
          {effectiveStep === 'owner' && managerId !== null && (
            <OwnerStep
              state={state}
              managerId={managerId}
              managerUsername={managerUsername}
              onBound={() => setStep('bot')}
            />
          )}
          {effectiveStep === 'bot' && managerId !== null && (
            <BotStep
              state={state}
              managerId={managerId}
              onCreated={(id, username) => {
                setChannelId(id)
                setBotUsername(username)
                setStep('binding')
              }}
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

/** 顶部步骤指示器：已完成打勾、当前高亮、未到的置灰 */
function StepIndicator({ current }: { current: number }) {
  const intl = useIntl()
  return (
    <nav className="mb-6 flex items-center">
      {STEP_ORDER.map((key, index) => {
        const done = index < current
        const active = index === current
        return (
          <Fragment key={key}>
            {index > 0 && <span className={`mx-2 h-px min-w-3 flex-1 ${done ? 'bg-accent/50' : 'bg-line'}`} />}
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                className={`flex size-5 items-center justify-center rounded-full text-[11px] font-medium ${
                  done
                    ? 'bg-accent text-white'
                    : active
                      ? 'border border-accent text-accent'
                      : 'border border-line text-ink-muted'
                }`}
              >
                {done ? '✓' : index + 1}
              </span>
              <span className={`text-xs ${active ? 'font-medium text-ink' : 'text-ink-muted'}`}>
                {intl.formatMessage({ id: `onboarding.progress.${key}` })}
              </span>
            </span>
          </Fragment>
        )
      })}
    </nav>
  )
}
