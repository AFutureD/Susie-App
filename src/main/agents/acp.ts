import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream, type Client } from '@agentclientprotocol/sdk'
import type { MessagePart } from '../../shared/messages'
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
  log: (message: string) => void
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
  private sessionId: string | null = null
  private modelOptions: AgentModelOption[] = []
  private model: string | null = null
  private turn: TurnState | null = null

  constructor(options: AcpRuntimeOptions) {
    this.options = options
  }

  private clientHandler(): Client {
    const handler = {
      requestPermission: (params: RequestPermissionRequest): RequestPermissionResponse => {
        const options = (params as { options?: { optionId: string; kind?: string }[] }).options ?? []
        const allowed = options.find((option) => option.kind === 'allow_always' || option.kind === 'allow_once')
        if (allowed === undefined) {
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
    child.stderr.on('data', (chunk: Buffer) => {
      this.options.log(`[acp:${this.options.cmd.split('/').at(-1) ?? 'agent'}] ${chunk.toString().trim()}`)
    })
    child.on('exit', (code) => {
      this.options.log(`acp agent 退出（code=${code ?? 'null'}）`)
      this.connection = null
      this.child = null
      this.sessionId = null
    })
    this.child = child

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    )
    const connection = new ClientSideConnection(() => this.clientHandler(), stream)

    await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    } as Parameters<ClientSideConnection['initialize']>[0])

    this.connection = connection
    return connection
  }

  async newSession(instruction?: string | null): Promise<string> {
    const connection = await this.ensureConnected()

    const mcpServers =
      this.options.mcpUrl === null
        ? []
        : [{ type: 'http', name: this.options.mcpName, url: this.options.mcpUrl, headers: [] }]

    const response = (await connection.newSession({
      cwd: this.options.cwd,
      mcpServers,
    } as Parameters<ClientSideConnection['newSession']>[0])) as unknown as {
      sessionId: string
      configOptions?: unknown
    }

    this.sessionId = response.sessionId
    this.parseConfigOptions(response.configOptions)

    if (instruction !== undefined && instruction !== null && instruction !== '') {
      // 系统指令作为首个 turn 注入，输出丢弃（对位 Python 行为）
      this.turn = { text: '', thought: '', toolCalls: new Map(), plan: '' }
      try {
        await connection.prompt({
          sessionId: response.sessionId,
          prompt: [{ type: 'text', text: instruction }],
        } as Parameters<ClientSideConnection['prompt']>[0])
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
      await connection.setSessionConfigOption({
        sessionId: this.sessionId,
        configId: 'model',
        value,
      } as Parameters<ClientSideConnection['setSessionConfigOption']>[0])
      this.model = value
      return true
    } catch {
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
    const connection = await this.ensureConnected()
    if (this.sessionId === null) await this.newSession(null)
    const sessionId = this.sessionId
    if (sessionId === null) throw new Error('acp session unavailable')

    const state: TurnState = { text: '', thought: '', toolCalls: new Map(), plan: '' }
    this.turn = state

    try {
      const response = (await connection.prompt({
        sessionId,
        prompt: [{ type: 'text', text }],
      } as Parameters<ClientSideConnection['prompt']>[0])) as unknown as { stopReason?: string }

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
