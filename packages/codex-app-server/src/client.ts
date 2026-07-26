// `codex app-server` stdio JSON-RPC 客户端（对位 openai_codex client.py 单一 reader 架构）。
// 泛型 request() 覆盖全部 130+ 协议方法（参数类型由生成的 ClientRequest 联合缩窄），
// 核心 thread/turn/model/account 面另提供带响应类型的包装。
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import { TransportClosedError } from './errors'
import type { ClientRequest } from './generated/ClientRequest'
import type { InitializeResponse } from './generated/InitializeResponse'
import type { ServerRequest } from './generated/ServerRequest'
import type { JsonValue } from './generated/serde_json/JsonValue'
import type { CancelLoginAccountResponse } from './generated/v2/CancelLoginAccountResponse'
import type { GetAccountResponse } from './generated/v2/GetAccountResponse'
import type { LoginAccountParams } from './generated/v2/LoginAccountParams'
import type { LoginAccountResponse } from './generated/v2/LoginAccountResponse'
import type { LogoutAccountResponse } from './generated/v2/LogoutAccountResponse'
import type { ModelListResponse } from './generated/v2/ModelListResponse'
import type { ThreadArchiveResponse } from './generated/v2/ThreadArchiveResponse'
import type { ThreadCompactStartResponse } from './generated/v2/ThreadCompactStartResponse'
import type { ThreadForkParams } from './generated/v2/ThreadForkParams'
import type { ThreadForkResponse } from './generated/v2/ThreadForkResponse'
import type { ThreadListParams } from './generated/v2/ThreadListParams'
import type { ThreadListResponse } from './generated/v2/ThreadListResponse'
import type { ThreadReadResponse } from './generated/v2/ThreadReadResponse'
import type { ThreadResumeParams } from './generated/v2/ThreadResumeParams'
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse'
import type { ThreadSetNameResponse } from './generated/v2/ThreadSetNameResponse'
import type { ThreadStartParams } from './generated/v2/ThreadStartParams'
import type { ThreadStartResponse } from './generated/v2/ThreadStartResponse'
import type { ThreadUnarchiveResponse } from './generated/v2/ThreadUnarchiveResponse'
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification'
import type { TurnInterruptResponse } from './generated/v2/TurnInterruptResponse'
import type { TurnStartParams } from './generated/v2/TurnStartParams'
import type { TurnStartResponse } from './generated/v2/TurnStartResponse'
import type { TurnSteerResponse } from './generated/v2/TurnSteerResponse'
import type { UserInput } from './generated/v2/UserInput'
import type { JsonObject, Notification } from './notifications'
import { MessageRouter } from './router'

export type ClientRequestMethod = ClientRequest['method']
/** 按方法名缩窄参数类型（全协议覆盖） */
export type ClientRequestParams<M extends ClientRequestMethod> = Extract<ClientRequest, { method: M }>['params']

export type ServerRequestHandler = (request: ServerRequest) => JsonObject | Promise<JsonObject>

/** 默认审批处理：无人值守下自动接受命令执行 / 文件变更审批（对位 Python 默认 handler） */
export function defaultServerRequestHandler(request: ServerRequest): JsonObject {
  if (request.method === 'item/commandExecution/requestApproval') return { decision: 'accept' }
  if (request.method === 'item/fileChange/requestApproval') return { decision: 'accept' }
  return {}
}

export interface CodexClientOptions {
  /** codex 可执行文件路径（调用方负责解析，如 Susie 的 CodexInstaller） */
  codexPath: string
  /** `--config key=value` 覆盖项 */
  configOverrides?: string[]
  cwd?: string
  /** 叠加到继承环境之上的环境变量 */
  env?: Record<string, string>
  /** 前置到 PATH 的目录（vendor codex-path，内含 rg 等辅助工具） */
  pathDirs?: string[]
  clientName?: string
  clientTitle?: string
  clientVersion?: string
  /** 启用实验性 API（thread/turn v2 面需要；默认 true） */
  experimentalApi?: boolean
  /** 服务端发来的请求（审批等）的处理器；缺省自动接受审批 */
  serverRequestHandler?: ServerRequestHandler
  onStderrLine?: (line: string) => void
}

const STDERR_TAIL_LIMIT = 400

function waitExit(
  proc: {
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    once(e: 'exit', l: () => void): unknown
    off(e: 'exit', l: () => void): unknown
  },
  ms: number,
): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      proc.off('exit', onExit)
      resolve(false)
    }, ms)
    proc.once('exit', onExit)
  })
}

export class CodexClient {
  private readonly options: CodexClientOptions
  private readonly router = new MessageRouter()
  private readonly stderrTailLines: string[] = []
  private proc: ChildProcessWithoutNullStreams | null = null
  private closed = false

  constructor(options: CodexClientOptions) {
    this.options = options
  }

  start(): void {
    if (this.proc !== null) return
    this.closed = false

    const args: string[] = []
    for (const kv of this.options.configOverrides ?? []) args.push('--config', kv)
    args.push('app-server', '--listen', 'stdio://')

    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value
    }
    Object.assign(env, this.options.env ?? {})
    const pathDirs = this.options.pathDirs ?? []
    if (pathDirs.length > 0) {
      const existing = env['PATH'] ?? ''
      env['PATH'] = [...pathDirs, ...existing.split(':').filter((entry) => entry !== '')].join(':')
    }

    const proc = spawn(this.options.codexPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      ...(this.options.cwd === undefined ? {} : { cwd: this.options.cwd }),
    })
    this.proc = proc

    const stdout = readline.createInterface({ input: proc.stdout })
    stdout.on('line', (line) => {
      this.handleLine(line)
    })
    const stderr = readline.createInterface({ input: proc.stderr })
    stderr.on('line', (line) => {
      this.stderrTailLines.push(line)
      if (this.stderrTailLines.length > STDERR_TAIL_LIMIT) this.stderrTailLines.shift()
      this.options.onStderrLine?.(line)
    })

    proc.on('error', (error) => {
      this.router.failAll(new TransportClosedError(`codex 进程启动失败：${error.message}`))
    })
    proc.on('exit', (code, signal) => {
      if (this.closed) return
      this.router.failAll(
        new TransportClosedError(
          `codex 进程退出（code=${code} signal=${signal}）。stderr_tail=${this.stderrTail().slice(0, 2000)}`,
        ),
      )
    })
  }

  /** initialize 握手 + initialized 通知；返回服务端元数据 */
  async initialize(): Promise<InitializeResponse> {
    const result = await this.request('initialize', {
      clientInfo: {
        name: this.options.clientName ?? 'susie_codex_app_server',
        title: this.options.clientTitle ?? 'Susie Codex App Server Client',
        version: this.options.clientVersion ?? '0.0.0',
      },
      capabilities: {
        experimentalApi: this.options.experimentalApi ?? true,
        requestAttestation: false,
      },
    })
    this.notify('initialized')
    return result as unknown as InitializeResponse
  }

  async close(): Promise<void> {
    const proc = this.proc
    if (proc === null) return
    this.closed = true
    this.proc = null
    proc.stdin.end()
    proc.kill()
    this.router.failAll(new TransportClosedError('客户端已关闭'))
    // 限时收尸：SIGTERM 无效则升级 SIGKILL，防止 codex 子进程成孤儿
    if (!(await waitExit(proc, 3000))) {
      proc.kill('SIGKILL')
      await waitExit(proc, 1000)
    }
  }

  get running(): boolean {
    return this.proc !== null
  }

  stderrTail(limit = 40): string {
    return this.stderrTailLines.slice(-limit).join('\n')
  }

  /** 发送 JSON-RPC 请求并等待响应；参数类型按方法名全协议缩窄 */
  async request<M extends ClientRequestMethod>(method: M, params?: ClientRequestParams<M>): Promise<JsonValue> {
    const requestId = randomUUID()
    const waiter = this.router.createResponseWaiter(requestId)
    try {
      const message: JsonObject = { id: requestId, method }
      if (params !== undefined) message['params'] = params as JsonValue
      this.writeMessage(message)
    } catch (error) {
      this.router.discardResponseWaiter(requestId)
      throw error
    }
    return waiter
  }

  /** 发送 JSON-RPC 通知（不等待响应） */
  notify(method: string, params?: JsonObject): void {
    const message: JsonObject = { method }
    if (params !== undefined) message['params'] = params as JsonValue
    this.writeMessage(message)
  }

  // ---------- 通知流 ----------

  nextGlobalNotification(): Promise<Notification> {
    return this.router.nextGlobalNotification()
  }

  registerTurnNotifications(turnId: string): void {
    this.router.registerTurn(turnId)
  }

  unregisterTurnNotifications(turnId: string): void {
    this.router.unregisterTurn(turnId)
  }

  nextTurnNotification(turnId: string): Promise<Notification> {
    return this.router.nextTurnNotification(turnId)
  }

  registerLoginNotifications(loginId: string): void {
    this.router.registerLogin(loginId)
  }

  unregisterLoginNotifications(loginId: string): void {
    this.router.unregisterLogin(loginId)
  }

  nextLoginNotification(loginId: string): Promise<Notification> {
    return this.router.nextLoginNotification(loginId)
  }

  /** 阻塞等待指定 turn 的完成通知 */
  async waitForTurnCompleted(turnId: string): Promise<TurnCompletedNotification> {
    this.registerTurnNotifications(turnId)
    try {
      for (;;) {
        const notification = await this.nextTurnNotification(turnId)
        if (notification.method === 'turn/completed') {
          const payload = notification.params as unknown as TurnCompletedNotification
          if (payload.turn.id === turnId) return payload
        }
      }
    } finally {
      this.unregisterTurnNotifications(turnId)
    }
  }

  // ---------- account ----------

  async accountLoginStart(params: LoginAccountParams): Promise<LoginAccountResponse> {
    const response = (await this.request('account/login/start', params)) as unknown as LoginAccountResponse
    if (response.type === 'chatgpt' || response.type === 'chatgptDeviceCode') {
      this.registerLoginNotifications(response.loginId)
    }
    return response
  }

  async accountLoginCancel(loginId: string): Promise<CancelLoginAccountResponse> {
    return (await this.request('account/login/cancel', { loginId })) as unknown as CancelLoginAccountResponse
  }

  async accountRead(refreshToken = false): Promise<GetAccountResponse> {
    return (await this.request('account/read', { refreshToken })) as unknown as GetAccountResponse
  }

  async accountLogout(): Promise<LogoutAccountResponse> {
    return (await this.request('account/logout')) as unknown as LogoutAccountResponse
  }

  // ---------- thread ----------

  async threadStart(params: ThreadStartParams): Promise<ThreadStartResponse> {
    return (await this.request('thread/start', params)) as unknown as ThreadStartResponse
  }

  async threadResume(params: ThreadResumeParams): Promise<ThreadResumeResponse> {
    return (await this.request('thread/resume', params)) as unknown as ThreadResumeResponse
  }

  async threadFork(params: ThreadForkParams): Promise<ThreadForkResponse> {
    return (await this.request('thread/fork', params)) as unknown as ThreadForkResponse
  }

  async threadList(params: ThreadListParams = {}): Promise<ThreadListResponse> {
    return (await this.request('thread/list', params)) as unknown as ThreadListResponse
  }

  async threadRead(threadId: string, includeTurns = false): Promise<ThreadReadResponse> {
    return (await this.request('thread/read', { threadId, includeTurns })) as unknown as ThreadReadResponse
  }

  async threadArchive(threadId: string): Promise<ThreadArchiveResponse> {
    return (await this.request('thread/archive', { threadId })) as unknown as ThreadArchiveResponse
  }

  async threadUnarchive(threadId: string): Promise<ThreadUnarchiveResponse> {
    return (await this.request('thread/unarchive', { threadId })) as unknown as ThreadUnarchiveResponse
  }

  async threadSetName(threadId: string, name: string): Promise<ThreadSetNameResponse> {
    return (await this.request('thread/name/set', { threadId, name })) as unknown as ThreadSetNameResponse
  }

  async threadCompact(threadId: string): Promise<ThreadCompactStartResponse> {
    return (await this.request('thread/compact/start', { threadId })) as unknown as ThreadCompactStartResponse
  }

  // ---------- turn ----------

  /** 启动 turn 并尽早注册通知队列（事件可能先于调用方开始消费就到达） */
  async turnStart(params: TurnStartParams): Promise<TurnStartResponse> {
    const started = (await this.request('turn/start', params)) as unknown as TurnStartResponse
    this.registerTurnNotifications(started.turn.id)
    return started
  }

  async turnSteer(threadId: string, expectedTurnId: string, input: UserInput[]): Promise<TurnSteerResponse> {
    return (await this.request('turn/steer', {
      threadId,
      expectedTurnId,
      input,
    })) as unknown as TurnSteerResponse
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<TurnInterruptResponse> {
    return (await this.request('turn/interrupt', { threadId, turnId })) as unknown as TurnInterruptResponse
  }

  // ---------- model ----------

  async modelList(includeHidden = false): Promise<ModelListResponse> {
    return (await this.request('model/list', { includeHidden })) as unknown as ModelListResponse
  }

  // ---------- 内部 ----------

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (trimmed === '') return
    let message: JsonObject
    try {
      message = JSON.parse(trimmed) as JsonObject
    } catch {
      // 非 JSON 行（如启动横幅）直接忽略，保持 reader 存活
      return
    }
    if (typeof message !== 'object' || message === null) return

    const method = message['method']
    const id = message['id']
    if (typeof method === 'string' && id !== undefined) {
      void this.handleServerRequest(message as unknown as ServerRequest)
      return
    }
    if (typeof method === 'string') {
      const params = message['params']
      this.router.routeNotification({
        method,
        params: params !== null && typeof params === 'object' && !Array.isArray(params) ? params : {},
      } as Notification)
      return
    }
    this.router.routeResponse(message)
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    const handler = this.options.serverRequestHandler ?? defaultServerRequestHandler
    let result: JsonObject
    try {
      result = await handler(request)
    } catch (error) {
      this.writeMessage({
        id: request.id as JsonValue,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      })
      return
    }
    this.writeMessage({ id: request.id as JsonValue, result })
  }

  private writeMessage(payload: JsonObject): void {
    const proc = this.proc
    if (proc === null || proc.stdin.destroyed) throw new TransportClosedError('codex 进程未运行')
    proc.stdin.write(`${JSON.stringify(payload)}\n`)
  }
}
