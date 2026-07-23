import { Codex, type Thread, type ThreadOptions } from '@openai/codex-sdk'
import type { MessagePart } from '../../shared/messages'
import { mapThreadItem } from './codex-map'
import type { AgentModelOption, AgentRuntime, AgentTurn } from './types'

export interface CodexRuntimeOptions {
  cwd: string
  /** 内置 MCP server 地址；null 表示不注入 */
  mcpUrl: string | null
  mcpName: string
  model: string | null
  /** /model 候选（来自 assistant 配置） */
  models: string[]
  /** codex 可执行文件路径（CodexInstaller 解析）；'codex' 表示交给 PATH */
  codexPath: string
  /** vendor codex-path 目录（rg 等辅助工具）；spawn 时前置到 PATH */
  codexPathDir: string | null
}

/** SDK 的 env 选项是整体替换而非合并，这里手动继承进程环境并前置 pathDir */
function envWithPathDir(pathDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  const current = env['PATH'] ?? ''
  env['PATH'] = current === '' ? pathDir : `${pathDir}:${current}`
  return env
}

/**
 * Codex 运行时（@openai/codex-sdk，`codex exec` JSONL 协议）。
 *
 * 与 Python 版（app-server SDK）的功能差异：
 * - 无法枚举模型 → 候选来自配置 models；切换模型 = 重建 thread（新会话）；
 * - 无系统指令入参 → 指令并入会话首个 prompt；
 * - 无 steer → 活跃 turn 期间来新消息时先取消当前 turn 再发新 turn。
 */
export class CodexRuntime implements AgentRuntime {
  private readonly options: CodexRuntimeOptions
  private readonly codex: Codex
  private thread: Thread | null = null
  private pendingInstruction: string | null = null
  private lastInstruction: string | null = null
  private model: string | null
  private active: AbortController | null = null

  constructor(options: CodexRuntimeOptions) {
    this.options = options
    this.model = options.model
    this.codex = new Codex({
      codexPathOverride: options.codexPath,
      ...(options.codexPathDir === null ? {} : { env: envWithPathDir(options.codexPathDir) }),
      config:
        options.mcpUrl === null
          ? {}
          : {
              mcp_servers: {
                // default_tools_approval_mode=approve：无人值守下自动批准 susie 自己的
                // MCP 工具（send_message 等）；否则 exec 非交互模式会直接取消审批请求。
                [options.mcpName]: { url: options.mcpUrl, default_tools_approval_mode: 'approve' },
              },
            },
    })
  }

  private threadOptions(): ThreadOptions {
    return {
      workingDirectory: this.options.cwd,
      skipGitRepoCheck: true,
      approvalPolicy: 'never',
      sandboxMode: 'workspace-write',
      networkAccessEnabled: true,
      ...(this.model === null ? {} : { model: this.model }),
    }
  }

  newSession(instruction?: string | null): Promise<string> {
    void this.cancel()
    this.thread = this.codex.startThread(this.threadOptions())
    this.pendingInstruction = instruction ?? null
    this.lastInstruction = instruction ?? null
    return Promise.resolve(this.thread.id ?? 'pending')
  }

  listModels(): Promise<AgentModelOption[]> {
    return Promise.resolve(this.options.models.map((value) => ({ value, name: value })))
  }

  currentModel(): Promise<string | null> {
    return Promise.resolve(this.model)
  }

  /** 切换模型会重建会话（exec 协议下 thread 选项在创建时固定） */
  setModel(value: string): Promise<boolean> {
    if (this.options.models.length > 0 && !this.options.models.includes(value)) {
      return Promise.resolve(false)
    }
    this.model = value
    this.thread = this.codex.startThread(this.threadOptions())
    this.pendingInstruction = this.lastInstruction
    return Promise.resolve(true)
  }

  cancel(): Promise<void> {
    this.active?.abort()
    return Promise.resolve()
  }

  async *prompt(text: string): AsyncGenerator<AgentTurn> {
    if (this.thread === null) {
      await this.newSession(this.lastInstruction)
    }
    const thread = this.thread
    if (thread === null) throw new Error('codex thread unavailable')

    // 活跃 turn 期间来了新消息：取消旧 turn（exec 协议不支持 steer）
    this.active?.abort()

    const input = this.pendingInstruction === null ? text : `${this.pendingInstruction}\n\n${text}`
    this.pendingInstruction = null

    const controller = new AbortController()
    this.active = controller

    const parts: MessagePart[] = []
    try {
      const { events } = await thread.runStreamed(input, { signal: controller.signal })
      for await (const event of events) {
        switch (event.type) {
          case 'item.completed':
            parts.push(...mapThreadItem(event.item))
            yield { status: 'in_progress', parts: [...parts], error: null }
            break
          case 'turn.completed':
            yield { status: 'completed', parts: [...parts], error: null }
            return
          case 'turn.failed':
            yield { status: 'failed', parts: [...parts], error: event.error?.message ?? 'turn failed' }
            return
          case 'error':
            yield { status: 'failed', parts: [...parts], error: event.message }
            return
          default:
            break
        }
      }
      // 事件流意外结束
      yield { status: 'completed', parts: [...parts], error: null }
    } catch (error) {
      if (controller.signal.aborted) {
        yield { status: 'cancelled', parts: [...parts], error: null }
        return
      }
      yield { status: 'failed', parts: [...parts], error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (this.active === controller) this.active = null
    }
  }

  async dispose(): Promise<void> {
    await this.cancel()
    this.thread = null
  }
}
