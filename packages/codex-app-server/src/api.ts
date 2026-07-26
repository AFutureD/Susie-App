// 高层 API（对位 openai_codex api.py 的 AsyncCodex/AsyncThread/AsyncTurnHandle）。
// JS 天然异步，不设同步双胞胎。
import { CodexClient, type CodexClientOptions } from './client'
import type { InitializeResponse } from './generated/InitializeResponse'
import type { Personality } from './generated/Personality'
import type { ReasoningEffort } from './generated/ReasoningEffort'
import type { ReasoningSummary } from './generated/ReasoningSummary'
import type { GetAccountResponse } from './generated/v2/GetAccountResponse'
import type { ModelListResponse } from './generated/v2/ModelListResponse'
import type { ThreadArchiveResponse } from './generated/v2/ThreadArchiveResponse'
import type { ThreadCompactStartResponse } from './generated/v2/ThreadCompactStartResponse'
import type { ThreadListParams } from './generated/v2/ThreadListParams'
import type { ThreadListResponse } from './generated/v2/ThreadListResponse'
import type { ThreadReadResponse } from './generated/v2/ThreadReadResponse'
import type { ThreadSetNameResponse } from './generated/v2/ThreadSetNameResponse'
import type { TurnInterruptResponse } from './generated/v2/TurnInterruptResponse'
import type { TurnSteerResponse } from './generated/v2/TurnSteerResponse'
import type { JsonValue } from './generated/serde_json/JsonValue'
import { toWireInput, type RunInput } from './inputs'
import { ChatgptLoginHandle, DeviceCodeLoginHandle } from './login'
import { approvalModeSettings, sandboxMode, sandboxPolicy, type ApprovalMode, type Sandbox } from './modes'
import type { Notification } from './notifications'
import { collectTurnResult, type TurnResult } from './run'

export interface ThreadStartOptions {
  approvalMode?: ApprovalMode
  baseInstructions?: string | null
  config?: { [key in string]?: JsonValue } | null
  cwd?: string | null
  developerInstructions?: string | null
  ephemeral?: boolean | null
  model?: string | null
  modelProvider?: string | null
  personality?: Personality | null
  sandbox?: Sandbox | null
}

export interface TurnOptions {
  approvalMode?: ApprovalMode
  cwd?: string | null
  effort?: ReasoningEffort | null
  model?: string | null
  outputSchema?: JsonValue | null
  personality?: Personality | null
  sandbox?: Sandbox | null
  summary?: ReasoningSummary | null
}

/** Codex app-server 会话入口；start()/initialize 惰性完成，close() 释放子进程 */
export class Codex {
  readonly client: CodexClient
  private init: InitializeResponse | null = null
  private initializing: Promise<void> | null = null

  constructor(options: CodexClientOptions) {
    this.client = new CodexClient(options)
  }

  async ensureInitialized(): Promise<void> {
    if (this.init !== null) return
    this.initializing ??= (async () => {
      try {
        this.client.start()
        this.init = await this.client.initialize()
      } catch (error) {
        void this.client.close()
        this.initializing = null
        throw error
      }
    })()
    await this.initializing
  }

  get metadata(): InitializeResponse {
    if (this.init === null) throw new Error('Codex 尚未初始化：先 await ensureInitialized() 或任一 API 调用')
    return this.init
  }

  async close(): Promise<void> {
    const closed = this.client.close()
    this.init = null
    this.initializing = null
    await closed
  }

  // ---------- account ----------

  async loginApiKey(apiKey: string): Promise<void> {
    await this.ensureInitialized()
    await this.client.accountLoginStart({ type: 'apiKey', apiKey })
  }

  async loginChatgpt(): Promise<ChatgptLoginHandle> {
    await this.ensureInitialized()
    const response = await this.client.accountLoginStart({ type: 'chatgpt' })
    if (response.type !== 'chatgpt') throw new Error(`ChatGPT 登录响应类型异常：${response.type}`)
    return new ChatgptLoginHandle(this.client, response.loginId, response.authUrl)
  }

  async loginChatgptDeviceCode(): Promise<DeviceCodeLoginHandle> {
    await this.ensureInitialized()
    const response = await this.client.accountLoginStart({ type: 'chatgptDeviceCode' })
    if (response.type !== 'chatgptDeviceCode') throw new Error(`设备码登录响应类型异常：${response.type}`)
    return new DeviceCodeLoginHandle(this.client, response.loginId, response.verificationUrl, response.userCode)
  }

  async account(refreshToken = false): Promise<GetAccountResponse> {
    await this.ensureInitialized()
    return this.client.accountRead(refreshToken)
  }

  async logout(): Promise<void> {
    await this.ensureInitialized()
    await this.client.accountLogout()
  }

  // ---------- thread ----------

  async threadStart(options: ThreadStartOptions = {}): Promise<Thread> {
    await this.ensureInitialized()
    const approval = approvalModeSettings(options.approvalMode ?? 'auto_review')
    const started = await this.client.threadStart({
      approvalPolicy: approval.approvalPolicy,
      approvalsReviewer: approval.approvalsReviewer,
      baseInstructions: options.baseInstructions ?? null,
      config: options.config ?? null,
      cwd: options.cwd ?? null,
      developerInstructions: options.developerInstructions ?? null,
      ephemeral: options.ephemeral ?? null,
      model: options.model ?? null,
      modelProvider: options.modelProvider ?? null,
      personality: options.personality ?? null,
      sandbox: options.sandbox == null ? null : sandboxMode(options.sandbox),
    })
    return new Thread(this, started.thread.id)
  }

  async threadResume(threadId: string, options: ThreadStartOptions = {}): Promise<Thread> {
    await this.ensureInitialized()
    const approval = options.approvalMode === undefined ? null : approvalModeSettings(options.approvalMode)
    const resumed = await this.client.threadResume({
      threadId,
      approvalPolicy: approval?.approvalPolicy ?? null,
      approvalsReviewer: approval?.approvalsReviewer ?? null,
      baseInstructions: options.baseInstructions ?? null,
      config: options.config ?? null,
      cwd: options.cwd ?? null,
      developerInstructions: options.developerInstructions ?? null,
      model: options.model ?? null,
      modelProvider: options.modelProvider ?? null,
      personality: options.personality ?? null,
      sandbox: options.sandbox == null ? null : sandboxMode(options.sandbox),
    })
    return new Thread(this, resumed.thread.id)
  }

  async threadFork(threadId: string, options: ThreadStartOptions = {}): Promise<Thread> {
    await this.ensureInitialized()
    const approval = options.approvalMode === undefined ? null : approvalModeSettings(options.approvalMode)
    const forked = await this.client.threadFork({
      threadId,
      approvalPolicy: approval?.approvalPolicy ?? null,
      approvalsReviewer: approval?.approvalsReviewer ?? null,
      baseInstructions: options.baseInstructions ?? null,
      config: options.config ?? null,
      cwd: options.cwd ?? null,
      developerInstructions: options.developerInstructions ?? null,
      ...(options.ephemeral == null ? {} : { ephemeral: options.ephemeral }),
      model: options.model ?? null,
      modelProvider: options.modelProvider ?? null,
      sandbox: options.sandbox == null ? null : sandboxMode(options.sandbox),
    })
    return new Thread(this, forked.thread.id)
  }

  async threadList(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    await this.ensureInitialized()
    return this.client.threadList(params)
  }

  async threadArchive(threadId: string): Promise<ThreadArchiveResponse> {
    await this.ensureInitialized()
    return this.client.threadArchive(threadId)
  }

  async threadUnarchive(threadId: string): Promise<Thread> {
    await this.ensureInitialized()
    const unarchived = await this.client.threadUnarchive(threadId)
    return new Thread(this, unarchived.thread.id)
  }

  // ---------- model ----------

  async models(includeHidden = false): Promise<ModelListResponse> {
    await this.ensureInitialized()
    return this.client.modelList(includeHidden)
  }
}

/** 会话线程：跑一或多个 turn */
export class Thread {
  private readonly codex: Codex
  readonly id: string

  constructor(codex: Codex, id: string) {
    this.codex = codex
    this.id = id
  }

  /** 启动一个 turn，返回可流式消费 / steer / interrupt 的句柄 */
  async turn(input: RunInput, options: TurnOptions = {}): Promise<TurnHandle> {
    await this.codex.ensureInitialized()
    const approval = options.approvalMode === undefined ? null : approvalModeSettings(options.approvalMode)
    const started = await this.codex.client.turnStart({
      threadId: this.id,
      input: toWireInput(input),
      approvalPolicy: approval?.approvalPolicy ?? null,
      approvalsReviewer: approval?.approvalsReviewer ?? null,
      cwd: options.cwd ?? null,
      effort: options.effort ?? null,
      model: options.model ?? null,
      outputSchema: options.outputSchema ?? null,
      personality: options.personality ?? null,
      sandboxPolicy: options.sandbox == null ? null : sandboxPolicy(options.sandbox),
      summary: options.summary ?? null,
    })
    return new TurnHandle(this.codex, this.id, started.turn.id)
  }

  /** 跑完整个 turn 并收集最终结果 */
  async run(input: RunInput, options: TurnOptions = {}): Promise<TurnResult> {
    const turn = await this.turn(input, options)
    return collectTurnResult(turn.stream(), turn.id)
  }

  async read(includeTurns = false): Promise<ThreadReadResponse> {
    await this.codex.ensureInitialized()
    return this.codex.client.threadRead(this.id, includeTurns)
  }

  async setName(name: string): Promise<ThreadSetNameResponse> {
    await this.codex.ensureInitialized()
    return this.codex.client.threadSetName(this.id, name)
  }

  async compact(): Promise<ThreadCompactStartResponse> {
    await this.codex.ensureInitialized()
    return this.codex.client.threadCompact(this.id)
  }
}

/** 活跃 turn 的控制句柄：steer 追加输入、interrupt 请求中断、stream 消费事件 */
export class TurnHandle {
  private readonly codex: Codex
  readonly threadId: string
  readonly id: string

  constructor(codex: Codex, threadId: string, id: string) {
    this.codex = codex
    this.threadId = threadId
    this.id = id
  }

  async steer(input: RunInput): Promise<TurnSteerResponse> {
    return this.codex.client.turnSteer(this.threadId, this.id, toWireInput(input))
  }

  async interrupt(): Promise<TurnInterruptResponse> {
    return this.codex.client.turnInterrupt(this.threadId, this.id)
  }

  /** 只产出路由到本 turn 的通知；turn/completed 后自动结束并注销队列 */
  async *stream(): AsyncGenerator<Notification> {
    this.codex.client.registerTurnNotifications(this.id)
    try {
      for (;;) {
        const notification = await this.codex.client.nextTurnNotification(this.id)
        yield notification
        if (notification.method === 'turn/completed') {
          const params = notification.params as { turn?: { id?: string } }
          if (params.turn?.id === this.id) return
        }
      }
    } finally {
      this.codex.client.unregisterTurnNotifications(this.id)
    }
  }

  /** 消费事件流直到完成并返回结果 */
  async run(): Promise<TurnResult> {
    return collectTurnResult(this.stream(), this.id)
  }
}
