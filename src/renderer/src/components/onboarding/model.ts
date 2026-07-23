import type { ConfigState } from '../../../../shared/config'

// 首启引导的判定逻辑（纯函数，便于单测）。UI 见 onboarding.tsx。

/** localStorage 标记：首启引导已完成或已跳过 */
export const ONBOARDING_DONE_KEY = 'susie.onboarding.done'

export type OnboardingStep = 'channel' | 'binding'

/**
 * 首启引导判定：返回应进入的步骤，null = 不显示。
 * 无频道 → 第 1 步；有频道但无任何绑定 → 第 2 步（覆盖引导中途退出的恢复）。
 * 配置损坏（lastError）时不判定——运行中的 config 是 last-good，不能据此认定「未配置」。
 */
export function onboardingStepFor(
  state: Pick<ConfigState, 'config' | 'lastError'>,
  done: boolean,
): OnboardingStep | null {
  if (done || state.lastError !== null) return null
  if (Object.keys(state.config.channels).length === 0) return 'channel'
  if (state.config.bindings.length === 0) return 'binding'
  return null
}
