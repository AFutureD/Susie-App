import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
import type { AssistantConfig } from '../shared/config'
import type { AgentsOverview, ChannelStatus, MessagePart, StoredMessage } from '../shared/messages'
import { AcpRuntime } from './agents/acp'
import { AcpRegistryManager, type AcpProgress } from './agents/acp-registry'
import { CodexRuntime } from './agents/codex'
import type { AgentRuntime } from './agents/types'
import { ChannelHub } from './channels/hub'
import { getWorkspaceDir } from './config/paths'
import type { ConfigStore } from './config/store'
import { SUSIE_MCP_NAME, SUSIE_MCP_PORT } from './constants'
import { ChatManager } from './core/chat-manager'
import { HistoryStore } from './history/store'
import { SusieMcpServer } from './mcp/server'

export interface ServiceEmit {
  channelStatuses: (statuses: ChannelStatus[]) => void
  historyMessage: (message: StoredMessage) => void
  agentsProgress: (progress: AcpProgress) => void
}

export interface ServicePaths {
  /** SQLite 历史库 */
  historyDb: string
  /** 附件下载目录 */
  attachmentsDir: string
  /** ACP registry 缓存目录 */
  acpDataDir: string
}

/**
 * 服务核心（对位 Python 的 APP 组装层）：
 * ConfigStore → ChannelHub → ChatManager → AgentRuntime(codex/acp)，
 * 内置 MCP server 反向暴露 send_message / list_messages / list_chats。
 */
export class SusieService {
  readonly history: HistoryStore
  readonly hub: ChannelHub
  readonly chatManager: ChatManager
  readonly mcp: SusieMcpServer
  readonly acpRegistry: AcpRegistryManager

  private readonly log: (message: string) => void

  constructor(store: ConfigStore, paths: ServicePaths, emit: ServiceEmit, log: (message: string) => void) {
    this.log = log
    this.history = new HistoryStore(paths.historyDb)
    this.mcp = new SusieMcpServer()
    this.acpRegistry = new AcpRegistryManager(paths.acpDataDir, emit.agentsProgress)

    this.chatManager = new ChatManager({
      store,
      history: this.history,
      mcpName: SUSIE_MCP_NAME,
      getChannel: (id) => this.hub.get(id),
      createRuntime: (assistant) => this.createRuntime(assistant),
      onHistoryMessage: emit.historyMessage,
      log,
    })

    this.hub = new ChannelHub({
      store,
      attachmentsDir: paths.attachmentsDir,
      onMessage: (envelope) => this.chatManager.handleInbound(envelope),
      onStatuses: emit.channelStatuses,
      onChannelRemoved: (channelId) => this.chatManager.onChannelRemoved(channelId),
      log,
    })
  }

  async start(): Promise<void> {
    try {
      const url = await this.mcp.start(SUSIE_MCP_PORT)
      this.log(`mcp server: ${url}`)
    } catch (error) {
      this.log(
        `mcp server 启动失败（agent 将无法反向操作 susie）：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    this.mcp.setBridge({
      sendMessage: async ({ channelId, chatId, content, files }) => {
        const parts: MessagePart[] = []
        if (content !== '') parts.push({ kind: 'text', text: content })
        for (const file of files) parts.push({ kind: 'file', path: file })
        return this.chatManager.sendMessage({ channelId, chatId, parts })
      },
      listMessages: ({ channelId, chatId, num, dateStart, dateEnd }) =>
        this.history.listMessages(channelId, chatId, { limit: num, dateStart, dateEnd }),
      listChats: (channelId) => this.history.listChats(channelId),
    })

    this.hub.start()
  }

  async stop(): Promise<void> {
    this.log('service stopping: chats')
    this.chatManager.dispose()
    this.log('service stopping: hub')
    await this.hub.stopAll()
    this.log('service stopping: mcp')
    await this.mcp.stop()
    this.log('service stopping: history')
    this.history.close()
    this.log('service stopped')
  }

  /** agent_id === 'codex' 用 Codex SDK；其余按 ACP registry 已安装的 agent 解析 */
  private async createRuntime(assistant: AssistantConfig): Promise<AgentRuntime> {
    const cwd = assistant.work_dir ?? getWorkspaceDir(assistant.id)
    fs.mkdirSync(cwd, { recursive: true })

    if (assistant.agent_id === 'codex') {
      return new CodexRuntime({
        cwd,
        mcpUrl: this.mcp.url,
        mcpName: SUSIE_MCP_NAME,
        model: assistant.model ?? null,
        models: assistant.models ?? [],
      })
    }

    const manifest = this.acpRegistry.installedManifest(assistant.agent_id)
    if (manifest === null) {
      throw new Error(`ACP agent "${assistant.agent_id}" 未安装——请到 Agent 页安装后重试`)
    }
    return new AcpRuntime({
      cmd: manifest.cmd,
      args: manifest.args,
      env: manifest.env,
      cwd,
      mcpUrl: this.mcp.url,
      mcpName: SUSIE_MCP_NAME,
      log: this.log,
    })
  }

  async agentsOverview(): Promise<AgentsOverview> {
    const codex = detectCodexCli()
    let acp: AgentsOverview['acp'] = []
    try {
      acp = await this.acpRegistry.overview()
    } catch (error) {
      this.log(`ACP registry 不可用：${error instanceof Error ? error.message : String(error)}`)
    }
    return { codex, acp }
  }
}

export function detectCodexCli(): { available: boolean; version: string | null } {
  // @openai/codex-sdk 自带 codex 二进制（@openai/codex 依赖），SDK 路径始终可用；
  // 这里报告的是 SDK 捆绑版本，供 Agent 页展示。
  try {
    const pkgPath = path.join(path.dirname(require.resolve('@openai/codex-sdk/package.json')), 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { dependencies?: Record<string, string> }
    const bundled = pkg.dependencies?.['@openai/codex'] ?? null
    if (bundled !== null) return { available: true, version: `sdk ${bundled}` }
  } catch {
    // fallthrough 到 PATH 检测
  }

  const probe = spawnSync('codex', ['--version'], { encoding: 'utf-8' })
  if (probe.status === 0) {
    return { available: true, version: probe.stdout.trim() }
  }
  return { available: false, version: null }
}
