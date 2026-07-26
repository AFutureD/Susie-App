import type { AgentInfo, AgentModelOption } from '../../../shared/messages'
import type { Logger } from '../../util/logger'
import type { AgentProvider, RuntimeSpec } from '../provider'
import type { AgentRuntime } from '../types'
import { CODEX_AGENT_ID, type CodexInstaller } from './installer'
import { fetchCodexModels } from './models'
import { CodexRuntime } from './runtime'

export class CodexProvider implements AgentProvider {
  readonly id = 'codex'

  constructor(
    private readonly installer: CodexInstaller,
    private readonly log: Logger,
  ) {}

  owns(agentId: string): boolean {
    return agentId === CODEX_AGENT_ID
  }

  overview(): Promise<AgentInfo[]> {
    const resolved = this.installer.resolve()
    return Promise.resolve([
      {
        id: CODEX_AGENT_ID,
        name: 'Codex',
        description: '内置下载器按需管理 codex 二进制（约 100MB）。',
        installable: true,
        installedVersion: resolved?.version ?? null,
        latestVersion: this.installer.targetVersion(),
        source: resolved?.source ?? null,
        // codex app-server 走本地 stdio，susie MCP 以 http 注入恒可用
        mcpHttp: true,
      },
    ])
  }

  async listModels(): Promise<AgentModelOption[]> {
    const codex = this.installer.resolve()
    if (codex === null) return []
    return fetchCodexModels({
      codexPath: codex.executablePath,
      pathDirs: codex.pathDir === null ? [] : [codex.pathDir],
    })
  }

  async install(): Promise<void> {
    await this.installer.install()
  }

  uninstall(): void {
    this.installer.uninstall()
  }

  createRuntime(spec: RuntimeSpec): Promise<AgentRuntime> {
    const codex = this.installer.resolve()
    if (codex === null) {
      return Promise.reject(new Error('codex 未安装——请到 Agent 页下载 codex 后重试'))
    }
    return Promise.resolve(
      new CodexRuntime({
        cwd: spec.cwd,
        mcpUrl: spec.mcpUrl,
        mcpName: spec.mcpName,
        model: spec.model,
        thinkingLevel: spec.thinkingLevel ?? null,
        models: spec.models,
        codexPath: codex.executablePath,
        codexPathDir: codex.pathDir,
        log: this.log,
      }),
    )
  }
}
