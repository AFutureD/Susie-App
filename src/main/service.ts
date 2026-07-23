import fs from 'node:fs'
import type { AssistantConfig } from '../shared/config'
import type { AgentProgress, AgentsOverview, ChannelStatus, MessagePart, StoredMessage } from '../shared/messages'
import { AcpRuntime } from './agents/acp'
import { AcpRegistryManager } from './agents/acp-registry'
import { CodexRuntime } from './agents/codex'
import { CODEX_AGENT_ID, CodexInstaller } from './agents/codex-installer'
import type { AgentRuntime } from './agents/types'
import { ChannelHub } from './channels/hub'
import { getWorkspaceDir } from './config/paths'
import type { ConfigStore } from './config/store'
import { SUSIE_MCP_NAME, SUSIE_MCP_PORT } from './constants'
import { ChatManager } from './core/chat-manager'
import { HistoryStore } from './history/store'
import { SusieMcpServer } from './mcp/server'
import type { Logger } from './util/logger'

export interface ServiceEmit {
  channelStatuses: (statuses: ChannelStatus[]) => void
  historyMessage: (message: StoredMessage) => void
  agentsProgress: (progress: AgentProgress) => void
}

export interface ServicePaths {
  /** SQLite 历史库 */
  historyDb: string
  /** 附件下载目录 */
  attachmentsDir: string
  /** ACP registry 缓存目录 */
  acpDataDir: string
  /** codex 二进制下载目录 */
  codexDataDir: string
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
  readonly codexInstaller: CodexInstaller

  private readonly log: Logger

  constructor(store: ConfigStore, paths: ServicePaths, emit: ServiceEmit, log: Logger) {
    this.log = log
    this.history = new HistoryStore(paths.historyDb)
    this.mcp = new SusieMcpServer(log)

    // 安装进度平时只推 UI；失败必须同时留日志痕迹
    const agentsProgress = (progress: AgentProgress): void => {
      if (progress.phase === 'error') {
        this.log.error(`agent ${progress.id} 安装失败：${progress.detail ?? '未知原因'}`)
      }
      emit.agentsProgress(progress)
    }
    this.acpRegistry = new AcpRegistryManager(paths.acpDataDir, agentsProgress)
    this.codexInstaller = new CodexInstaller(paths.codexDataDir, agentsProgress)

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
      this.log.info(`mcp server: ${url}`)
    } catch (error) {
      this.log.error(
        `mcp server 启动失败（agent 将无法反向操作 susie）：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    this.mcp.setBridge({
      sendMessage: async ({ channelId, chatId, content, files }) => {
        const parts: MessagePart[] = []
        if (content !== '') parts.push({ kind: 'text', text: content })
        for (const file of files) parts.push({ kind: 'file', path: file })
        // 失败会被 SusieMcpServer 的 tool 层统一记 error 日志并回给 agent
        return this.chatManager.sendMessage({ channelId, chatId, parts })
      },
      listMessages: ({ channelId, chatId, num, dateStart, dateEnd }) =>
        this.history.listMessages(channelId, chatId, { limit: num, dateStart, dateEnd }),
      listChats: (channelId) => this.history.listChats(channelId),
    })

    this.hub.start()
  }

  async stop(): Promise<void> {
    this.log.info('service stopping: chats')
    this.chatManager.dispose()
    this.log.info('service stopping: hub')
    await this.hub.stopAll()
    this.log.info('service stopping: mcp')
    await this.mcp.stop()
    this.log.info('service stopping: history')
    this.history.close()
    this.log.info('service stopped')
  }

  /** agent_id === 'codex' 用 Codex SDK；其余按 ACP registry 已安装的 agent 解析 */
  private async createRuntime(assistant: AssistantConfig): Promise<AgentRuntime> {
    const cwd = assistant.work_dir ?? getWorkspaceDir(assistant.id)
    fs.mkdirSync(cwd, { recursive: true })

    if (assistant.agent_id === CODEX_AGENT_ID) {
      const codex = this.codexInstaller.resolve()
      if (codex === null) {
        throw new Error('codex 未安装——请到 Agent 页下载 codex 后重试')
      }
      return new CodexRuntime({
        cwd,
        mcpUrl: this.mcp.url,
        mcpName: SUSIE_MCP_NAME,
        model: assistant.model ?? null,
        models: assistant.models ?? [],
        codexPath: codex.executablePath,
        codexPathDir: codex.pathDir,
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
    const resolved = this.codexInstaller.resolve()
    let acp: AgentsOverview['acp'] = []
    try {
      acp = await this.acpRegistry.overview()
    } catch (error) {
      this.log.error(`ACP registry 不可用：${error instanceof Error ? error.message : String(error)}`)
    }
    return {
      codex: {
        available: resolved !== null,
        source: resolved?.source ?? null,
        version: resolved?.version ?? null,
        targetVersion: this.codexInstaller.targetVersion(),
      },
      acp,
    }
  }

  /** codex 走内置下载器，其余按 ACP registry 处理 */
  async installAgent(id: string): Promise<void> {
    if (id === CODEX_AGENT_ID) {
      await this.codexInstaller.install()
      return
    }
    await this.acpRegistry.install(id)
  }

  uninstallAgent(id: string): void {
    if (id === CODEX_AGENT_ID) {
      this.codexInstaller.uninstall()
      return
    }
    this.acpRegistry.uninstall(id)
  }
}
