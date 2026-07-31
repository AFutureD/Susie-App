import fs from 'node:fs'
import type { AssistantConfig, AutoReviewConfig } from '../shared/config'
import type { AgentProgress, MessagePart } from '../shared/messages'
import type { IpcBroadcaster } from '../shared/ipc/events'
import { AcpProvider } from './agents/acp/provider'
import { AcpRegistryManager } from './agents/acp/registry'
import { CodexProvider } from './agents/codex/provider'
import { CodexInstaller } from './agents/codex/installer'
import { AgentManager } from './agents/manager'
import type { AgentRuntime } from './agents/types'
import { ChannelHub } from './channels/hub'
import { DiscoveryRepo } from './channels/telegram/discovery-repo'
import { telegramBotFactory } from './channels/telegram/factory'
import { ManagedBotRegistry } from './channels/telegram/managed-bots'
import type { ChannelFactory } from './channels/types'
import { getWorkspaceDir } from './config/paths'
import type { ConfigStore } from './config/store'
import { SUSIE_MCP_NAME, SUSIE_MCP_PORT } from './constants'
import { ApprovalManager } from './core/approvals'
import { AutoReviewer } from './core/auto-review'
import { ChatManager } from './core/chat-manager'
import { AppDatabase } from './db/database'
import { MessageRepo } from './history/message-repo'
import { ApprovalRepo } from './core/approval-repo'
import { AutoReviewRepo } from './core/auto-review-repo'
import { SusieMcpServer } from './mcp/server'
import { SkillsManager } from './skills/manager'
import { TaskRunRepo } from './tasks/task-run-repo'
import { TaskScheduler } from './tasks/scheduler'
import { withTimeout } from './util/async'
import type { Logger } from './util/logger'

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
  readonly db: AppDatabase
  readonly messages: MessageRepo
  readonly approvalRepo: ApprovalRepo
  readonly autoReviewRepo: AutoReviewRepo
  readonly taskRuns: TaskRunRepo
  readonly hub: ChannelHub
  readonly managedBots: ManagedBotRegistry
  readonly chatManager: ChatManager
  readonly approvals: ApprovalManager
  readonly autoReviewer: AutoReviewer
  readonly scheduler: TaskScheduler
  readonly mcp: SusieMcpServer
  readonly agents: AgentManager
  readonly skills: SkillsManager

  private readonly log: Logger
  private readonly unsubUsers: () => void

  constructor(store: ConfigStore, paths: ServicePaths, broadcast: IpcBroadcaster, log: Logger) {
    this.log = log
    this.db = new AppDatabase(paths.historyDb)
    this.messages = new MessageRepo(this.db)
    this.approvalRepo = new ApprovalRepo(this.db)
    this.autoReviewRepo = new AutoReviewRepo(this.db)
    this.mcp = new SusieMcpServer(log)

    // 安装进度平时只推 UI；失败必须同时留日志痕迹
    const agentsProgress = (progress: AgentProgress): void => {
      if (progress.phase === 'error') {
        this.log.error(`agent ${progress.id} 安装失败：${progress.detail ?? '未知原因'}`)
      }
      broadcast('agents.progress', progress)
    }
    const acpRegistry = new AcpRegistryManager(paths.acpDataDir, agentsProgress)
    const codexInstaller = new CodexInstaller(paths.codexDataDir, agentsProgress)
    // 有序注册：codex 精确认领，acp 兜底（owns 恒真）必须在末位
    this.agents = new AgentManager(
      [new CodexProvider(codexInstaller, log), new AcpProvider(acpRegistry, SUSIE_MCP_NAME, log)],
      log,
    )
    this.skills = new SkillsManager(store, log)

    // approvals ↔ chatManager ↔ hub 相互引用，一律用延迟闭包解环（构造顺序无关）
    this.approvals = new ApprovalManager({
      store,
      approvals: this.approvalRepo,
      messages: this.messages,
      getChannel: (id) => this.hub.get(id),
      dispatchApproved: (pending) => this.chatManager.handleApproved(pending),
      terminateChat: (pending) => this.chatManager.cancelActiveTurn(pending.channelId, pending.chatId),
      onHistoryMessage: (message) => broadcast('history.message', message),
      log,
    })

    this.autoReviewer = new AutoReviewer({
      store,
      reviews: this.autoReviewRepo,
      createRuntime: (config) => this.createReviewRuntime(config),
      emit: (record) => broadcast('autoReview.record', record),
      log,
    })

    this.taskRuns = new TaskRunRepo(this.db)
    this.scheduler = new TaskScheduler({
      store,
      runs: this.taskRuns,
      createRuntime: (assistant) => this.createTaskRuntime(assistant),
      // 延迟闭包：chatManager 在下方构造（与 approvals 同款解环手法）
      sendMessage: (input) => this.chatManager.sendMessage(input),
      emit: (record) => broadcast('tasks.run', record),
      log,
    })

    // manager bot 编排：常驻轮询发现 managed bot（发现 ≠ 添加，addManagedBot 是唯一建渠道入口）
    this.managedBots = new ManagedBotRegistry({
      store,
      repo: new DiscoveryRepo(this.db),
      emit: (managerId, discoveries) => broadcast('managerBots.discoveries', { managerId, discoveries }),
      onMessage: (envelope) => this.chatManager.handleInbound(envelope),
      onStatuses: (statuses) => broadcast('managerBots.status', statuses),
      log,
    })

    this.chatManager = new ChatManager({
      store,
      messages: this.messages,
      mcpName: SUSIE_MCP_NAME,
      // manager 不在 hub：fallback 到 registry，history 页 composer 才能给 manager 私聊发消息
      getChannel: (id) => this.hub.get(id) ?? this.managedBots.get(id),
      createRuntime: (assistant) => this.createRuntime(assistant),
      onHistoryMessage: (message) => broadcast('history.message', message),
      // 注意透传 options：autoReviewReason 要随卡片显示（漏传曾导致拒绝原因永远上不了卡片）
      requestApproval: (envelope, options) => this.approvals.request(envelope, options),
      autoReview: (envelope) => this.autoReviewer.review(envelope),
      beginAutoReview: (envelope) => this.approvals.beginAutoReview(envelope),
      settleAutoReview: (pending, verdict) => this.approvals.settleAutoReview(pending, verdict),
      log,
    })

    this.hub = new ChannelHub({
      store,
      factories: new Map<string, ChannelFactory>([[telegramBotFactory.type, telegramBotFactory]]),
      attachmentsDir: paths.attachmentsDir,
      listCommands: () => this.chatManager.listCommandSpecs(),
      // 完整命令菜单只给能执行需审核命令的私聊：owner + 私聊直通档
      listPrivilegedUserIds: (channelId) =>
        store.current.users
          .filter((user) => user.channel === channelId && (user.role === 'owner' || user.private === 'allow'))
          .map((user) => user.user_id),
      onMessage: (envelope) => this.chatManager.handleInbound(envelope),
      onCallback: (event) => void this.approvals.handleCallback(event),
      onStatuses: (statuses) => broadcast('channels.status', statuses),
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
      sendMessage: async ({ channelId, chatId, content, files, replyTo }) => {
        const parts: MessagePart[] = []
        if (content !== '') parts.push({ kind: 'text', text: content })
        for (const file of files) parts.push({ kind: 'file', path: file })
        // MCP 走的路径必须能落到 turn 锚点上（普通线程 fallback 保回复位）；replyTo 语义在 chatManager 处理
        // 失败会被 SusieMcpServer 的 tool 层统一记 error 日志并回给 agent
        return this.chatManager.sendMessage({ channelId, chatId, parts, replyTo, useTurnAnchor: true })
      },
      listMessages: ({ channelId, chatId, num, dateStart, dateEnd }) =>
        this.messages.listMessages(channelId, chatId, { limit: num, dateStart, dateEnd }),
      listChats: (channelId) => this.messages.listChats(channelId),
    })

    this.hub.start()
    this.managedBots.start()
    this.scheduler.start()
  }

  async stop(): Promise<void> {
    this.unsubUsers()
    // 先停调度器：不再产生新执行，且在跑任务的投递/落库依赖 hub 与 db
    this.log.info('service stopping: scheduler')
    await this.scheduler.stop()
    this.log.info('service stopping: chats')
    // 各段自带预算（index.ts 的 5s 总闸只作最后兜底）：
    // 会话销毁要等 agent 子进程限时收尸；mcp.stop 不允许挂住退出
    await withTimeout(this.chatManager.dispose(), 3500, undefined)
    this.log.info('service stopping: hub')
    await this.hub.stopAll()
    this.log.info('service stopping: manager bots')
    await this.managedBots.stopAll()
    this.log.info('service stopping: mcp')
    await withTimeout(this.mcp.stop(), 2000, undefined)
    this.skills.dispose()
    this.log.info('service stopping: db')
    this.db.close()
    this.log.info('service stopped')
  }

  /** 会话运行时：注入 susie MCP；工作目录缺省 workspace/<assistant.id>（环境准备留在 service 层） */
  private createRuntime(assistant: AssistantConfig): Promise<AgentRuntime> {
    const cwd = assistant.work_dir ?? getWorkspaceDir(assistant.id)
    fs.mkdirSync(cwd, { recursive: true })
    return this.agents.createRuntime({
      agentId: assistant.agent_id,
      model: assistant.model ?? null,
      thinkingLevel: assistant.thinking_level ?? null,
      models: assistant.models ?? [],
      cwd,
      mcpUrl: this.mcp.url,
      mcpName: SUSIE_MCP_NAME,
    })
  }

  /** 定时任务运行时：工作目录同会话运行时；不注入 susie MCP（结果由调度器统一投递） */
  private createTaskRuntime(assistant: AssistantConfig): Promise<AgentRuntime> {
    const cwd = assistant.work_dir ?? getWorkspaceDir(assistant.id)
    fs.mkdirSync(cwd, { recursive: true })
    return this.agents.createRuntime({
      agentId: assistant.agent_id,
      model: assistant.model ?? null,
      thinkingLevel: assistant.thinking_level ?? null,
      models: [],
      cwd,
      mcpUrl: null,
      mcpName: SUSIE_MCP_NAME,
    })
  }

  /** 自动审核运行时：不注入 susie MCP（审核 agent 不应对外发消息），用独立工作目录 */
  private createReviewRuntime(config: AutoReviewConfig): Promise<AgentRuntime> {
    const cwd = getWorkspaceDir('auto-review')
    fs.mkdirSync(cwd, { recursive: true })
    return this.agents.createRuntime({
      agentId: config.agent_id,
      model: config.model ?? null,
      thinkingLevel: config.thinking_level ?? null,
      models: [],
      cwd,
      mcpUrl: null,
      mcpName: SUSIE_MCP_NAME,
    })
  }
}
