import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type Client } from '@agentclientprotocol/sdk'
import type { MessagePart } from '../../shared/messages'
import { withDeadline } from '../util/async'
import type { Logger } from '../util/logger'
import type { AgentModelOption, AgentRuntime, AgentTurn } from './types'

type RequestPermissionRequest = Parameters<Client['requestPermission']>[0]
type RequestPermissionResponse = Awaited<ReturnType<Client['requestPermission']>>
type SessionNotification = Parameters<Client['sessionUpdate']>[0]

export interface AcpRuntimeOptions {
  cmd: string
  args: string[]
  env: Record<string, string>
  cwd: string
  mcpUrl: string | null
  mcpName: string
  /** 助手配置的默认模型；null 用 agent 默认 */
  model: string | null
  log: Logger
}

interface ToolCallState {
  title: string
  status: string
  detail: string
}

interface TurnState {
  text: string
  thought: string
  toolCalls: Map<string, ToolCallState>
  plan: string
}

function contentBlockText(block: unknown): string {
  if (typeof block !== 'object' || block === null) return ''
  const record = block as Record<string, unknown>
  return record['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : ''
}

/**
 * ACP agent 运行时：spawn 已安装的 agent 二进制（stdio），走
 * initialize → session/new(mcpServers) → session/prompt，sessionUpdate 通知累积成消息 parts。
 * 无人值守策略与 Python 版一致：requestPermission 自动选第一个 allow 选项。
 */
export class AcpRuntime implements AgentRuntime {
  private readonly options: AcpRuntimeOptions
  private child: ChildProcessWithoutNullStreams | null = null
  private connection: ClientSideConnection | null = null
  private exitRejection: Promise<never> | null = null
  private sessionId: string | null = null
  private modelOptions: AgentModelOption[] = []
  private model: string | null = null
  private turn: TurnState | null = null
  /** turn 串行链：并发 prompt 时后到者等待前一 turn 结束（ACP 不支持同 session 并发 prompt） */
  private turnChain: Promise<void> = Promise.resolve()

  constructor(options: AcpRuntimeOptions) {
    this.options = options
  }

  private clientHandler(): Client {
    const handler = {
      requestPermission: (params: RequestPermissionRequest): RequestPermissionResponse => {
        const options = (params as { options?: { optionId: string; kind?: string }[] }).options ?? []
        const allowed = options.find((option) => option.kind === 'allow_always' || option.kind === 'allow_once')
        if (allowed === undefined) {
          // 无人值守下自动取消——agent 的这次操作会失败，必须留痕说明原因
          this.options.log.info(
            `acp agent 权限请求无 allow 选项，已自动取消（options=${options.map((o) => o.kind ?? o.optionId).join(',') || '空'}）`,
          )
          return { outcome: { outcome: 'cancelled' } } as RequestPermissionResponse
        }
        return { outcome: { outcome: 'selected', optionId: allowed.optionId } } as RequestPermissionResponse
      },
      sessionUpdate: (params: SessionNotification): void => {
        this.handleSessionUpdate(params as unknown as { update?: Record<string, unknown> })
      },
    }
    return handler as unknown as Client
  }

  private handleSessionUpdate(notification: { update?: Record<string, unknown> }): void {
    const update = notification.update
    if (update === undefined) return
    const kind = update['sessionUpdate']
    const turn = this.turn
    if (turn === null) return

    switch (kind) {
      case 'agent_message_chunk':
        turn.text += contentBlockText(update['content'])
        break
      case 'agent_thought_chunk':
        turn.thought += contentBlockText(update['content'])
        break
      case 'tool_call':
      case 'tool_call_update': {
        const id = typeof update['toolCallId'] === 'string' ? update['toolCallId'] : 'tool'
        const prev = turn.toolCalls.get(id) ?? { title: id, status: 'pending', detail: '' }
        const title = typeof update['title'] === 'string' ? update['title'] : prev.title
        const status = typeof update['status'] === 'string' ? update['status'] : prev.status
        const content = update['content']
        let detail = prev.detail
        if (Array.isArray(content)) {
          const text = content
            .map((item) => contentBlockText((item as Record<string, unknown>)['content'] ?? item))
            .join('')
          if (text !== '') detail = text
        }
        turn.toolCalls.set(id, { title, status, detail })
        break
      }
      case 'plan': {
        const entries = update['entries']
        if (Array.isArray(entries)) {
          turn.plan = entries
            .map((entry) => {
              const record = entry as Record<string, unknown>
              return `- [${record['status'] === 'completed' ? 'x' : ' '}] ${String(record['content'] ?? '')}`
            })
            .join('\n')
        }
        break
      }
      default:
        break
    }
  }

  private async ensureConnected(): Promise<ClientSideConnection> {
    if (this.connection !== null) return this.connection

    const child = spawn(this.options.cmd, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    // spawn 失败（如二进制缺失）或进程退出时让在途请求立刻失败——
    // 否则 initialize/prompt 永远 pending，该 chat 的消息队列会被永久卡死（用户看不到任何反馈）。
    const exitRejection = new Promise<never>((_resolve, reject) => {
      child.once('error', (error: Error) => {
        reject(new Error(`acp agent 启动失败：${error.message}`))
      })
      child.on('exit', (code) => {
        reject(new Error(`acp agent 已退出（code=${code ?? 'null'}）`))
      })
    })
    // 空闲时进程退出也会 reject，预挂 handler 防 unhandled rejection
    exitRejection.catch(() => {})
    this.exitRejection = exitRejection

    child.stderr.on('data', (chunk: Buffer) => {
      this.options.log.info(`[acp:${this.options.cmd.split('/').at(-1) ?? 'agent'}] ${chunk.toString().trim()}`)
    })
    child.on('exit', (code) => {
      const line = `acp agent 退出（code=${code ?? 'null'}）`
      if (code === 0 || code === null) {
        this.options.log.info(line)
      } else {
        this.options.log.error(line)
      }
      this.connection = null
      this.child = null
      this.sessionId = null
      this.exitRejection = null
    })
    this.child = child

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    const connection = new ClientSideConnection(() => this.clientHandler(), stream)

    try {
      await withDeadline(
        this.raceExit(
          connection.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          } as Parameters<ClientSideConnection['initialize']>[0]),
        ),
        15_000,
        'acp initialize',
      )
    } catch (error) {
      child.kill()
      this.child = null
      this.exitRejection = null
      throw error
    }

    this.connection = connection
    return connection
  }

  /** 在途请求与 agent 进程退出赛跑，防止请求永远 pending */
  private raceExit<T>(promise: Promise<T>): Promise<T> {
    const exitRejection = this.exitRejection
    return exitRejection === null ? promise : Promise.race([promise, exitRejection])
  }

  async newSession(instruction?: string | null): Promise<string> {
    const connection = await this.ensureConnected()

    const mcpServers =
      this.options.mcpUrl === null
        ? []
        : [{ type: 'http', name: this.options.mcpName, url: this.options.mcpUrl, headers: [] }]

    const response = (await this.raceExit(
      connection.newSession({
        cwd: this.options.cwd,
        mcpServers,
      } as Parameters<ClientSideConnection['newSession']>[0]),
    )) as unknown as {
      sessionId: string
      configOptions?: unknown
    }

    this.sessionId = response.sessionId
    this.parseConfigOptions(response.configOptions)
    await this.applyConfiguredModel()

    if (instruction !== undefined && instruction !== null && instruction !== '') {
      // 系统指令作为首个 turn 注入，输出丢弃（对位 Python 行为）
      this.turn = { text: '', thought: '', toolCalls: new Map(), plan: '' }
      try {
        await this.raceExit(
          connection.prompt({
            sessionId: response.sessionId,
            prompt: [{ type: 'text', text: instruction }],
          } as Parameters<ClientSideConnection['prompt']>[0]),
        )
      } finally {
        this.turn = null
      }
    }

    return response.sessionId
  }

  private parseConfigOptions(configOptions: unknown): void {
    this.modelOptions = []
    if (!Array.isArray(configOptions)) return
    for (const option of configOptions) {
      const record = option as Record<string, unknown>
      if (record['id'] !== 'model' || !Array.isArray(record['options'])) continue
      this.model = typeof record['value'] === 'string' ? record['value'] : null
      this.modelOptions = (record['options'] as Record<string, unknown>[]).map((item) => ({
        value: String(item['value'] ?? item['id'] ?? ''),
        name: String(item['label'] ?? item['name'] ?? item['value'] ?? ''),
      }))
    }
  }

  /**
   * 应用助手配置的默认模型。放在 newSession 内部：首建、/new、进程退出后
   * prompt 重建三条路径都会经过这里。失败降级到 agent 默认，不阻断会话建立。
   */
  private async applyConfiguredModel(): Promise<void> {
    const configured = this.options.model
    if (configured === null || configured === '' || configured === this.model) return
    const ok = await this.setModel(configured)
    if (!ok) {
      this.options.log.error(`acp 应用配置模型 "${configured}" 失败，使用 agent 默认（${this.model ?? '未知'}）`)
    }
  }

  listModels(): Promise<AgentModelOption[]> {
    return Promise.resolve(this.modelOptions)
  }

  currentModel(): Promise<string | null> {
    return Promise.resolve(this.model)
  }

  async setModel(value: string): Promise<boolean> {
    const connection = this.connection
    if (connection === null || this.sessionId === null) return false
    try {
      await this.raceExit(
        connection.setSessionConfigOption({
          sessionId: this.sessionId,
          configId: 'model',
          value,
        } as Parameters<ClientSideConnection['setSessionConfigOption']>[0]),
      )
      this.model = value
      return true
    } catch (error) {
      // 返回 false 会被上层解释为"不在候选列表内"，真实原因只能靠日志区分
      this.options.log.error(`acp setModel(${value}) 失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  async cancel(): Promise<void> {
    const connection = this.connection
    if (connection === null || this.sessionId === null) return
    try {
      await (connection as unknown as { cancel: (params: { sessionId: string }) => Promise<void> }).cancel({
        sessionId: this.sessionId,
      })
    } catch {
      // agent 可能已退出
    }
  }

  async *prompt(text: string): AsyncGenerator<AgentTurn> {
    // chat-manager 的 turn 消费在队列临界区外（codex steer 需要并发到达 prompt）；
    // ACP 同一 session 不支持并发 prompt，这里串行化保持既有先来后到行为
    const previous = this.turnChain
    let release: () => void = () => {}
    this.turnChain = new Promise((resolve) => {
      release = resolve
    })
    await previous

    try {
      const connection = await this.ensureConnected()
      if (this.sessionId === null) await this.newSession(null)
      const sessionId = this.sessionId
      if (sessionId === null) throw new Error('acp session unavailable')

      const state: TurnState = { text: '', thought: '', toolCalls: new Map(), plan: '' }
      this.turn = state

      try {
        const response = (await this.raceExit(
          connection.prompt({
            sessionId,
            prompt: [{ type: 'text', text }],
          } as Parameters<ClientSideConnection['prompt']>[0]),
        )) as unknown as { stopReason?: string }

        const parts = assembleParts(state)
        if (response.stopReason === 'cancelled') {
          yield { status: 'cancelled', parts, error: null }
        } else if (response.stopReason === 'refusal') {
          yield { status: 'failed', parts, error: 'agent refused the request' }
        } else {
          yield { status: 'completed', parts, error: null }
        }
      } catch (error) {
        yield {
          status: 'failed',
          parts: assembleParts(state),
          error: error instanceof Error ? error.message : String(error),
        }
      } finally {
        this.turn = null
      }
    } finally {
      release()
    }
  }

  async dispose(): Promise<void> {
    await this.cancel()
    this.child?.kill()
    this.child = null
    this.connection = null
    this.sessionId = null
  }
}

function assembleParts(state: TurnState): MessagePart[] {
  const parts: MessagePart[] = []
  if (state.thought !== '') parts.push({ kind: 'quote', title: '[reasoning]', body: state.thought })
  for (const call of state.toolCalls.values()) {
    parts.push({ kind: 'quote', title: `[${call.status}] ${call.title}`, body: call.detail })
  }
  if (state.plan !== '') parts.push({ kind: 'quote', title: '[plan]', body: state.plan })
  if (state.text !== '') parts.push({ kind: 'text', text: state.text })
  return parts
}
