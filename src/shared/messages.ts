// 消息领域模型（对位 Python susie_core.chat），main 与 renderer 共享。

export type MessagePart =
  { kind: 'text'; text: string } | { kind: 'file'; path: string } | { kind: 'quote'; title: string; body: string }

export interface ChatMessage {
  /** 通道内的消息 id（发送前为 null） */
  id: string | null
  channelId: string
  chatId: string
  /** 覆盖投递目标（assistant.forward_to） */
  receiver: string | null
  replyTo: string | null
  /** 是否本方（bot/用户自己）发出 */
  out: boolean
  sender: string | null
  /** epoch 毫秒 */
  timestamp: number
  parts: MessagePart[]
}

export interface StoredMessage extends ChatMessage {
  /** 历史库自增主键，用于分页 */
  rowid: number
}

export interface ChatInfo {
  channelId: string
  chatId: string
  name: string | null
  lastTs: number
}

export type ChannelState = 'stopped' | 'starting' | 'running' | 'error'

export interface ChannelStatus {
  id: string
  state: ChannelState
  detail: string | null
}

/** Agent 安装态（Agent 管理页） */
/** agent 安装进度事件（codex 下载器与 ACP registry 共用） */
export interface AgentProgress {
  id: string
  phase: 'downloading' | 'extracting' | 'done' | 'error'
  detail: string | null
  /** downloading 阶段已接收字节数 */
  received?: number
  /** 总字节数；服务端未返回 content-length 时为 null */
  total?: number | null
}

export interface AgentsOverview {
  codex: {
    available: boolean
    /** 二进制来源：本地下载 / 开发 node_modules / PATH；不可用为 null */
    source: 'installed' | 'dev' | 'path' | null
    version: string | null
    /** SDK 期望的 codex 版本（下载目标） */
    targetVersion: string | null
  }
  acp: AcpAgentRow[]
}

export interface AcpAgentRow {
  id: string
  name: string
  version: string
  description: string
  /** 本平台是否有可用分发（binary/npx） */
  installable: boolean
  installedVersion: string | null
}

export function partsToPromptText(parts: MessagePart[]): string {
  return parts
    .map((part) => {
      switch (part.kind) {
        case 'text':
          return part.text
        case 'file':
          return `<file>${part.path}</file>`
        case 'quote':
          return `<block>${part.title}\n${part.body}</block>`
      }
    })
    .filter((line) => line !== '')
    .join('\n')
}

export function partsToPlainText(parts: MessagePart[]): string {
  return parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('\n')
}
