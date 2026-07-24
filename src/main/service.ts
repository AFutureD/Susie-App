import fs from 'node:fs'
import os from 'node:os'
import type { AssistantConfig, AutoReviewConfig } from '../shared/config'
import type {
  AgentModelOption,
  AgentProgress,
  AgentsOverview,
  AutoReviewRecord,
  ChannelStatus,
  MessagePart,
  StoredMessage,
} from '../shared/messages'
import { AcpRuntime } from './agents/acp'
import { AcpRegistryManager } from './agents/acp-registry'
import { CodexRuntime } from './agents/codex'
import { CODEX_AGENT_ID, CodexInstaller } from './agents/codex-installer'
import { fetchCodexModels } from './agents/codex-models'
import type { AgentRuntime } from './agents/types'
import { ChannelHub } from './channels/hub'
import { getWorkspaceDir } from './config/paths'
import type { ConfigStore } from './config/store'
import { SUSIE_MCP_NAME, SUSIE_MCP_PORT } from './constants'
import { ApprovalManager } from './core/approvals'
import { AutoReviewer } from './core/auto-review'
import { ChatManager } from './core/chat-manager'
import { HistoryStore } from './history/store'
import { SusieMcpServer } from './mcp/server'
import { withDeadline } from './util/async'
import type { Logger } from './util/logger'

/** 模型枚举结果缓存时长（探针要起子进程，避免每次打开表单都付启动成本） */
const MODEL_OPTIONS_TTL_MS = 5 * 60 * 1000

export interface ServiceEmit {
  channelStatuses: (statuses: ChannelStatus[]) => void
  historyMessage: (message: StoredMessage) => void
  agentsProgress: (progress: AgentProgress) => void
  autoReview: (record: AutoReviewRecord) => void
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
  readonly approvals: ApprovalManager
  readonly autoReviewer: AutoReviewer
  readonly mcp: SusieMcpServer
  readonly acpRegistry: AcpRegistryManager
  readonly codexInstaller: CodexInstaller

  private readonly log: Logger
  private readonly unsubUsers: () => void

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

    // approvals ↔ chatManager ↔ hub 相互引用，一律用延迟闭包解环（构造顺序无关）
    this.approvals = new ApprovalManager({
      store,
      history: this.history,
      getChannel: (id) => this.hub.get(id),
      dispatchApproved: (pending) => this.chatManager.handleApproved(pending),
      terminateChat: (pending) => this.chatManager.cancelActiveTurn(pending.channelId, pending.chatId),
      onHistoryMessage: emit.historyMessage,
      log,
    })

    this.autoReviewer = new AutoReviewer({
      store,
      history: this.history,
      createRuntime: (config) => this.createReviewRuntime(config),
      emit: emit.autoReview,
      log,
    })

    this.chatManager = new ChatManager({
      store,
      history: this.history,
      mcpName: SUSIE_MCP_NAME,
      getChannel: (id) => this.hub.get(id),
      createRuntime: (assistant) => this.createRuntime(assistant),
      onHistoryMessage: emit.historyMessage,
      // 注意透传 options：autoReviewReason 要随卡片显示（漏传曾导致拒绝原因永远上不了卡片）
      requestApproval: (envelope, options) => this.approvals.request(envelope, options),
      autoReview: (envelope) => this.autoReviewer.review(envelope),
      beginAutoReview: (envelope) => this.approvals.beginAutoReview(envelope),
      settleAutoReview: (pending, verdict) => this.approvals.settleAutoReview(pending, verdict),
      log,
    })

    this.hub = new ChannelHub({
      store,
      attachmentsDir: paths.attachmentsDir,
      listCommands: () => this.chatManager.listCommandSpecs(),
      // 完整命令菜单只给能执行需审核命令的私聊：owner + 私聊直通档
      listPrivilegedUserIds: (channelId) =>
        store.current.users
          .filter((user) => user.channel === channelId && (user.role === 'owner' || user.private === 'allow'))
          .map((user) => user.user_id),
      onMessage: (envelope) => this.chatManager.handleInbound(envelope),
      onCallback: (event) => void this.approvals.handleCallback(event),
      onStatuses: emit.channelStatuses,
      onChannelRemoved: (channelId) => this.chatManager.onChannelRemoved(channelId),
      log,
    })

    // 权限名单变化 → 各通道命令菜单重新同步（谁能看到需审核命令随之变化）
    this.unsubUsers = store.subscribePath('users', () => this.hub.refreshCommandMenus())
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
    this.unsubUsers()
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
  private createRuntime(assistant: AssistantConfig): Promise<AgentRuntime> {
    const cwd = assistant.work_dir ?? getWorkspaceDir(assistant.id)
    return this.buildRuntime({
      agentId: assistant.agent_id,
      model: assistant.model ?? null,
      thinkingLevel: assistant.thinking_level ?? null,
      models: assistant.models ?? [],
      cwd,
      mcpUrl: this.mcp.url,
    })
  }

  /** 自动审核运行时：不注入 susie MCP（审核 agent 不应对外发消息），用独立工作目录 */
  private createReviewRuntime(config: AutoReviewConfig): Promise<AgentRuntime> {
    return this.buildRuntime({
      agentId: config.agent_id,
      model: config.model ?? null,
      thinkingLevel: config.thinking_level ?? null,
      models: [],
      cwd: getWorkspaceDir('auto-review'),
      mcpUrl: null,
    })
  }

  private async buildRuntime(spec: {
    agentId: string
    model: string | null
    thinkingLevel: AssistantConfig['thinking_level'] | null
    models: string[]
    cwd: string
    mcpUrl: string | null
  }): Promise<AgentRuntime> {
    fs.mkdirSync(spec.cwd, { recursive: true })

    if (spec.agentId === CODEX_AGENT_ID) {
      const codex = this.codexInstaller.resolve()
      if (codex === null) {
        throw new Error('codex 未安装——请到 Agent 页下载 codex 后重试')
      }
      return new CodexRuntime({
        cwd: spec.cwd,
        mcpUrl: spec.mcpUrl,
        mcpName: SUSIE_MCP_NAME,
        model: spec.model,
        thinkingLevel: spec.thinkingLevel ?? null,
        models: spec.models,
        codexPath: codex.executablePath,
        codexPathDir: codex.pathDir,
        log: this.log,
      })
    }

    const manifest = this.acpRegistry.installedManifest(spec.agentId)
    if (manifest === null) {
      throw new Error(`ACP agent "${spec.agentId}" 未安装——请到 Agent 页安装后重试`)
    }
    return new AcpRuntime({
      cmd: manifest.cmd,
      args: manifest.args,
      env: manifest.env,
      cwd: spec.cwd,
      mcpUrl: spec.mcpUrl,
      mcpName: SUSIE_MCP_NAME,
      model: spec.model,
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

  /** 模型枚举缓存（agent id → 结果）；只缓存非空结果，失败时下次重试 */
  private readonly modelOptionsCache = new Map<string, { at: number; options: AgentModelOption[] }>()

  /** 枚举 agent 的模型候选（UI 下拉用）；agent 未安装或枚举失败返回 [] */
  async listAgentModels(agentId: string): Promise<AgentModelOption[]> {
    const cached = this.modelOptionsCache.get(agentId)
    if (cached !== undefined && Date.now() - cached.at < MODEL_OPTIONS_TTL_MS) return cached.options
    const options = await this.probeAgentModels(agentId)
    if (options.length > 0) this.modelOptionsCache.set(agentId, { at: Date.now(), options })
    return options
  }

  private async probeAgentModels(agentId: string): Promise<AgentModelOption[]> {
    try {
      if (agentId === CODEX_AGENT_ID) {
        const codex = this.codexInstaller.resolve()
        if (codex === null) return []
        return await fetchCodexModels({
          codexPath: codex.executablePath,
          pathDirs: codex.pathDir === null ? [] : [codex.pathDir],
        })
      }
      const manifest = this.acpRegistry.installedManifest(agentId)
      if (manifest === null) return []
      // ACP 的模型列表只在 session/new 的 configOptions 里给：起一次性会话读完即弃
      const runtime = new AcpRuntime({
        cmd: manifest.cmd,
        args: manifest.args,
        env: manifest.env,
        cwd: os.tmpdir(),
        mcpUrl: null,
        mcpName: SUSIE_MCP_NAME,
        model: null,
        log: this.log,
      })
      try {
        await withDeadline(runtime.newSession(null), 30_000, `acp ${agentId} 模型枚举`)
        return await runtime.listModels()
      } finally {
        void runtime.dispose()
      }
    } catch (error) {
      this.log.error(`agent ${agentId} 模型枚举失败：${error instanceof Error ? error.message : String(error)}`)
      return []
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
