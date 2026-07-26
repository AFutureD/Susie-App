import os from 'node:os'
import type { AgentInfo, AgentModelOption } from '../../../shared/messages'
import { withDeadline } from '../../util/async'
import type { Logger } from '../../util/logger'
import type { AgentProvider, RuntimeSpec } from '../provider'
import type { AgentRuntime } from '../types'
import type { AcpRegistryManager } from './registry'
import { AcpRuntime } from './runtime'

/**
 * ACP registry provider：拥有除内置 agent 之外的任意 registry id（owns 恒真），
 * 必须放在 AgentManager 注册序的末位兜底。
 */
export class AcpProvider implements AgentProvider {
  readonly id = 'acp'

  constructor(
    private readonly registry: AcpRegistryManager,
    private readonly mcpName: string,
    private readonly log: Logger,
  ) {}

  owns(): boolean {
    return true
  }

  async overview(): Promise<AgentInfo[]> {
    const rows = await this.registry.overview()
    return rows.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      installable: agent.installable,
      installedVersion: agent.installedVersion,
      latestVersion: agent.version,
      source: agent.installedVersion !== null ? ('installed' as const) : null,
      mcpHttp: agent.mcpHttp,
    }))
  }

  /** ACP 的模型列表只在 session/new 的 configOptions 里给：起一次性会话读完即弃 */
  async listModels(agentId: string): Promise<AgentModelOption[]> {
    const manifest = this.registry.installedManifest(agentId)
    if (manifest === null) return []
    const runtime = new AcpRuntime({
      cmd: manifest.cmd,
      args: manifest.args,
      env: manifest.env,
      cwd: os.tmpdir(),
      mcpUrl: null,
      mcpName: this.mcpName,
      model: null,
      log: this.log,
    })
    try {
      await withDeadline(runtime.newSession(null), 30_000, `acp ${agentId} 模型枚举`)
      return await runtime.listModels()
    } finally {
      void runtime.dispose()
    }
  }

  async install(agentId: string): Promise<void> {
    await this.registry.install(agentId)
  }

  uninstall(agentId: string): void {
    this.registry.uninstall(agentId)
  }

  createRuntime(spec: RuntimeSpec): Promise<AgentRuntime> {
    const manifest = this.registry.installedManifest(spec.agentId)
    if (manifest === null) {
      return Promise.reject(new Error(`ACP agent "${spec.agentId}" 未安装——请到 Agent 页安装后重试`))
    }
    return Promise.resolve(
      new AcpRuntime({
        cmd: manifest.cmd,
        args: manifest.args,
        env: manifest.env,
        cwd: spec.cwd,
        mcpUrl: spec.mcpUrl,
        mcpName: spec.mcpName,
        model: spec.model,
        log: this.log,
      }),
    )
  }
}
