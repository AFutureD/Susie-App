import type { ConfigState } from '../../../../shared/config'

// 首启引导的判定逻辑（纯函数，便于单测）。UI 见 onboarding.tsx。

/**
 * 是否进入首启引导：仅当本次启动时 config.toml 不存在（firstRun，init 已随即写入默认文件；
 * 删除 config.toml 重启即可重新触发）。已有配置文件不进向导，无论内容多不完整；
 * 文件损坏（lastError）同样不进——错误横幅负责提示，向导写入会覆盖用户手改内容。
 */
export function shouldOnboard(state: Pick<ConfigState, 'firstRun' | 'lastError'>): boolean {
  return state.firstRun && state.lastError === null
}
