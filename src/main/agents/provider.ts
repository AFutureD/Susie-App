import type { ThinkingLevel } from '../../shared/config'
import type { AgentInfo, AgentModelOption } from '../../shared/messages'
import type { AgentRuntime } from './types'

// Agent 供应侧抽象：codex（内置下载器）与 ACP registry 各自实现 AgentProvider，
// 由 AgentManager 以「有序列表 + owns() 认领」解析——ACP 拥有任意 registry id，
// 因此注册表不能是 Map，末位 provider 以 owns: () => true 兜底。

export interface RuntimeSpec {
  agentId: string
  model: string | null
  thinkingLevel: ThinkingLevel | null
  /** /model 命令的候选白名单（legacy 手改 TOML 兼容） */
  models: string[]
  cwd: string
  mcpUrl: string | null
  mcpName: string
}

export interface AgentProvider {
  readonly id: string
  /** 是否认领该 agentId（按 AgentManager 注册序先到先得） */
  owns(agentId: string): boolean
  /** 本 provider 的可安装/已安装 agent 清单（同构行，供 UI 平铺） */
  overview(): Promise<AgentInfo[]>
  /** 枚举模型候选；未安装或失败返回 [] */
  listModels(agentId: string): Promise<AgentModelOption[]>
  install(agentId: string): Promise<void>
  uninstall(agentId: string): void
  createRuntime(spec: RuntimeSpec): Promise<AgentRuntime>
}
