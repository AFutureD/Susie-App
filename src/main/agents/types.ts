import type { MessagePart } from '../../shared/messages'

export interface AgentModelOption {
  value: string
  name: string
}

export type TurnStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled'

export interface AgentTurn {
  status: TurnStatus
  parts: MessagePart[]
  error: string | null
}

/** Agent 运行时接口（对位 Python AgentRuntime Protocol） */
export interface AgentRuntime {
  /** 建立新会话；instruction 为渲染后的系统指令 */
  newSession(instruction?: string | null): Promise<string>
  listModels(): Promise<AgentModelOption[]>
  currentModel(): Promise<string | null>
  setModel(value: string): Promise<boolean>
  cancel(): Promise<void>
  /** 单轮对话；completed / failed 时 parts 为整轮累计输出 */
  prompt(text: string): AsyncGenerator<AgentTurn>
  dispose(): Promise<void>
}
