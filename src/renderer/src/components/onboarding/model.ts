import { expandBindings } from '../../../../shared/bindings'
import { DEFAULT_ASSISTANT_ID, type AssistantConfig, type ConfigState } from '../../../../shared/config'
import type { AgentInfo } from '../../../../shared/messages'

// 首启引导的判定逻辑（纯函数，便于单测）。UI 见 onboarding.tsx。

/**
 * 是否进入首启引导：仅当本次启动时 config.toml 不存在（firstRun，init 已随即写入默认文件；
 * 删除 config.toml 重启即可重新触发）。已有配置文件不进向导，无论内容多不完整；
 * 文件损坏（lastError）同样不进——错误横幅负责提示，向导写入会覆盖用户手改内容。
 */
export function shouldOnboard(state: Pick<ConfigState, 'firstRun' | 'lastError'>): boolean {
  return state.firstRun && state.lastError === null
}

/**
 * agent 步收尾时校正 default 助手的 agent 指向：schema 默认 agent_id 是 codex，
 * 但用户在向导里可能只准备了其他 agent（如 claude-acp）——指向不可用且存在可用
 * 候选时返回改写后的 assistant（调用方负责 upsert），否则 null 表示无需改动。
 * 候选口径与 assistants 页一致：source 非空，且支持 http MCP（mcpHttp === false 排除，
 * null 视为未知保守放行）。
 */
export function reconcileDefaultAssistant(
  assistants: readonly AssistantConfig[],
  overview: readonly AgentInfo[],
): AssistantConfig | null {
  const assistant = assistants.find((item) => item.id === DEFAULT_ASSISTANT_ID) ?? assistants[0]
  if (assistant === undefined) return null
  if (overview.some((agent) => agent.id === assistant.agent_id && agent.source !== null)) return null
  const fallback = overview.find((agent) => agent.source !== null && agent.mcpHttp !== false)
  if (fallback === undefined) return null
  return { ...assistant, agent_id: fallback.id }
}

/**
 * 关闭/跳过向导时是否需要写回落绑定：渠道已建好但还没有通道默认绑定
 * （绑定步被打断）——此时补一条 { default 助手, respond: false }，
 * 保证「添加渠道必有默认绑定」的不变量；已有默认绑定或渠道不存在则不写。
 */
export function needsFallbackBinding(state: ConfigState, channelId: string | null): boolean {
  if (channelId === null || !(channelId in state.config.channels)) return false
  return expandBindings(state.config.bindings).wildcard[channelId] === undefined
}
