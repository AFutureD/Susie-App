import {
  Codex,
  TransportClosedError,
  type Notification,
  type ReasoningEffort,
  type Thread,
  type ThreadItem,
  type TurnCompletedNotification,
  type TurnHandle,
} from '@susie/codex-app-server'
import type { MessagePart } from '../../../shared/messages'
import { SerialGate } from '../../util/async'
import type { Logger } from '../../util/logger'
import { mapAppServerModels } from './models'
import { mapThreadItem } from './map'
import type { AgentModelOption, AgentRuntime, AgentTurn } from '../types'

export interface CodexRuntimeOptions {
  cwd: string
  /** 内置 MCP server 地址；null 表示不注入 */
  mcpUrl: string | null
  mcpName: string
  model: string | null
  /** 思考深度；null 用 codex 默认 */
  thinkingLevel: ReasoningEffort | null
  /** /model 候选白名单（assistant 配置）；空则经 app-server 动态枚举 */
  models: string[]
  /** codex 可执行文件路径（CodexInstaller 解析）；'codex' 表示交给 PATH */
  codexPath: string
  /** vendor codex-path 目录（rg 等辅助工具）；spawn 时前置到 PATH */
  codexPathDir: string | null
  log?: Logger
}

/**
 * Codex 运行时（@susie/codex-app-server，`codex app-server` JSON-RPC 协议，对位 Python
 * openai_codex CodexSDKRuntime）：
 * - 常驻 app-server 连接；系统指令走 thread/start 的 baseInstructions（不再拼进首个 prompt）；
 * - 活跃 turn 期间来新消息 → turn/steer 并入当前 turn（返回空流，输出走原 turn）；
 * - cancel → turn/interrupt；切换模型只改后续 turn 的 model 覆盖，不重建会话。
 */
export class CodexRuntime implements AgentRuntime {
  private readonly options: CodexRuntimeOptions
  private codex: Codex | null = null
  private thread: Thread | null = null
  private activeTurn: TurnHandle | null = null
  /** steer-or-start 判定的串行闸门（不覆盖 turn 流消费） */
  private readonly startGate = new SerialGate()
  /** turn 启动临界区：保证 steer-or-start 判定原子，避免同一 thread 并发 turn/start */
  private model: string | null
  private lastInstruction: string | null = null
  private modelOptions: AgentModelOption[] | null = null

  constructor(options: CodexRuntimeOptions) {
    this.options = options
    this.model = options.model
  }

  private ensureCodex(): Codex {
    if (this.codex !== null) return this.codex

    const configOverrides: string[] = ['sandbox_workspace_write.network_access=true']
    if (this.options.mcpUrl !== null) {
      const name = this.options.mcpName
      configOverrides.push(
        `mcp_servers.${name}.enable=true`,
        `mcp_servers.${name}.url=${this.options.mcpUrl}`,
        // 无人值守下自动批准 susie 自己的 MCP 工具（send_message 等）
        `mcp_servers.${name}.default_tools_approval_mode=approve`,
      )
    }

    this.codex = new Codex({
      codexPath: this.options.codexPath,
      configOverrides,
      cwd: this.options.cwd,
      pathDirs: this.options.codexPathDir === null ? [] : [this.options.codexPathDir],
      clientName: 'susie',
      clientTitle: 'Susie',
      onStderrLine: (line) => this.options.log?.info(`codex stderr: ${line}`),
    })
    return this.codex
  }

  async newSession(instruction?: string | null): Promise<string> {
    await this.cancel()
    const codex = this.ensureCodex()
    this.thread = await codex.threadStart({
      cwd: this.options.cwd,
      baseInstructions: instruction ?? null,
      model: this.model,
      sandbox: 'workspace-write',
      approvalMode: 'auto_review',
    })
    this.lastInstruction = instruction ?? null
    return this.thread.id
  }

  async listModels(): Promise<AgentModelOption[]> {
    if (this.options.models.length > 0) {
      return this.options.models.map((value) => ({ value, name: value }))
    }
    return (await this.fetchModelOptions()) ?? []
  }

  /** model/list 结果按 runtime 实例缓存；失败返回 null（调用方降级） */
  private async fetchModelOptions(): Promise<AgentModelOption[] | null> {
    if (this.modelOptions !== null) return this.modelOptions
    try {
      const response = await this.ensureCodex().models()
      this.modelOptions = mapAppServerModels(response.data)
      return this.modelOptions
    } catch (error) {
      this.options.log?.error(`codex 模型枚举失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  currentModel(): Promise<string | null> {
    return Promise.resolve(this.model)
  }

  /** 切换模型只更新后续 turn 的 model 覆盖（对位 Python set_model），会话保持 */
  async setModel(value: string): Promise<boolean> {
    if (this.options.models.length > 0) {
      if (!this.options.models.includes(value)) return false
    } else {
      // 枚举可用时按候选校验；探针失败则放行，交给下轮 turn 报错
      const options = await this.fetchModelOptions()
      if (options !== null && !options.some((option) => option.value === value)) return false
    }
    this.model = value
    return true
  }

  async cancel(): Promise<void> {
    const turn = this.activeTurn
    if (turn === null) return
    try {
      await turn.interrupt()
    } catch (error) {
      this.options.log?.info(`codex turn interrupt 失败（turn 可能已结束）：${String(error)}`)
    }
  }

  async *prompt(text: string): AsyncGenerator<AgentTurn> {
    // steer-or-start 临界区：并发 prompt 时后到者要么 steer，要么等前者 turn/start 完成
    // （只锁判定段，turn 流消费在临界区外——这是与 ACP 全 turn 串行的有意差异）
    const release = await this.startGate.acquire()

    let turn: TurnHandle
    try {
      if (this.activeTurn !== null) {
        try {
          await this.activeTurn.steer(text)
          this.options.log?.info(`codex turn ${this.activeTurn.id} steer：新消息已并入当前 turn`)
          return
        } catch (error) {
          // 竞态：turn 恰好已结束 → 降级为新 turn
          this.options.log?.info(`codex steer 失败（turn 已结束），改为新 turn：${String(error)}`)
        }
      }

      if (this.thread === null) await this.newSession(this.lastInstruction)
      const thread = this.thread
      if (thread === null) throw new Error('codex thread unavailable')

      turn = await thread.turn(text, {
        model: this.model,
        ...(this.options.thinkingLevel === null ? {} : { effort: this.options.thinkingLevel }),
      })
      this.activeTurn = turn
    } finally {
      release()
    }

    const parts: MessagePart[] = []
    try {
      for await (const notification of turn.stream()) {
        const mapped = this.mapNotification(notification, parts)
        if (mapped !== null) {
          yield mapped
          if (mapped.status !== 'in_progress') return
        }
      }
      // 事件流意外结束（未见 turn/completed）
      yield { status: 'completed', parts: [...parts], error: null }
    } catch (error) {
      if (error instanceof TransportClosedError) {
        yield { status: 'failed', parts: [...parts], error: error.message }
        return
      }
      yield { status: 'failed', parts: [...parts], error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (this.activeTurn === turn) this.activeTurn = null
    }
  }

  private mapNotification(notification: Notification, parts: MessagePart[]): AgentTurn | null {
    if (notification.method === 'item/completed') {
      const item = (notification.params as { item?: ThreadItem }).item
      if (item !== undefined) parts.push(...mapThreadItem(item))
      return { status: 'in_progress', parts: [...parts], error: null }
    }
    if (notification.method === 'turn/completed') {
      const payload = notification.params as unknown as TurnCompletedNotification
      switch (payload.turn.status) {
        case 'completed':
          return { status: 'completed', parts: [...parts], error: null }
        case 'interrupted':
          return { status: 'cancelled', parts: [...parts], error: null }
        case 'failed':
          return { status: 'failed', parts: [...parts], error: payload.turn.error?.message ?? 'turn failed' }
        default:
          return null
      }
    }
    return null
  }

  async dispose(): Promise<void> {
    await this.cancel()
    // close() 等子进程退出（限时 SIGKILL 收尸），防止 codex 子进程成孤儿
    await this.codex?.close()
    this.codex = null
    this.thread = null
    this.activeTurn = null
  }
}
