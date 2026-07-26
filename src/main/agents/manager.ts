import type { AgentInfo, AgentModelOption } from '../../shared/messages'
import { errorMessage } from '../../shared/errors'
import type { Logger } from '../util/logger'
import type { AgentProvider, RuntimeSpec } from './provider'
import type { AgentRuntime } from './types'

/** 模型枚举结果缓存时长（探针要起子进程，避免每次打开表单都付启动成本） */
const MODEL_OPTIONS_TTL_MS = 5 * 60 * 1000

/**
 * Agent 门面：按注册序解析 provider（owns() 认领，末位兜底），聚合 overview，
 * 缓存模型枚举。IPC handlers 与 SusieService 都只依赖本类，不再感知具体 provider。
 */
export class AgentManager {
  /** 模型枚举缓存（agent id → 结果）；只缓存非空结果，失败时下次重试 */
  private readonly modelOptionsCache = new Map<string, { at: number; options: AgentModelOption[] }>()

  constructor(
    private readonly providers: readonly AgentProvider[],
    private readonly log: Logger,
  ) {}

  private resolve(agentId: string): AgentProvider {
    const provider = this.providers.find((candidate) => candidate.owns(agentId))
    if (provider === undefined) {
      // 注册表以 owns: () => true 的 provider 兜底，正常配置下不可达
      throw new Error(`没有 provider 认领 agent "${agentId}"`)
    }
    return provider
  }

  /**
   * 按注册序聚合；单 provider 失败 → 该段为空 + error 日志（如 ACP registry 拉取失败）。
   * 行归属跟随解析规则：某 id 由更前位 provider 认领时，后位 provider 的同 id 行不展示
   * （例：ACP registry 也收录 codex，但 codex 的安装/运行时由内置 provider 负责，只显示内置行）。
   */
  async overview(): Promise<AgentInfo[]> {
    const sections = await Promise.all(
      this.providers.map(async (provider) => {
        try {
          const rows = await provider.overview()
          return rows.filter((row) => this.resolve(row.id) === provider)
        } catch (error) {
          this.log.error(`agent provider ${provider.id} overview 失败：${errorMessage(error)}`)
          return []
        }
      }),
    )
    return sections.flat()
  }

  /** 枚举 agent 的模型候选（UI 下拉 / /model 列表用）；agent 未安装或枚举失败返回 [] */
  async listModels(agentId: string): Promise<AgentModelOption[]> {
    const cached = this.modelOptionsCache.get(agentId)
    if (cached !== undefined && Date.now() - cached.at < MODEL_OPTIONS_TTL_MS) return cached.options
    let options: AgentModelOption[] = []
    try {
      options = await this.resolve(agentId).listModels(agentId)
    } catch (error) {
      this.log.error(`agent ${agentId} 模型枚举失败：${errorMessage(error)}`)
      return []
    }
    if (options.length > 0) this.modelOptionsCache.set(agentId, { at: Date.now(), options })
    return options
  }

  async install(agentId: string): Promise<void> {
    await this.resolve(agentId).install(agentId)
  }

  uninstall(agentId: string): void {
    this.resolve(agentId).uninstall(agentId)
  }

  createRuntime(spec: RuntimeSpec): Promise<AgentRuntime> {
    return this.resolve(spec.agentId).createRuntime(spec)
  }
}
