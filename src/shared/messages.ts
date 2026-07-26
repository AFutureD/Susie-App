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
  /** 发送者的平台用户 id（telegram user id）；出站/未知时为 null */
  senderId: string | null
  /** epoch 毫秒 */
  timestamp: number
  parts: MessagePart[]
}

export interface StoredMessage extends ChatMessage {
  /** 历史库自增主键，用于分页 */
  rowid: number
}

/**
 * 通道入站信封（channels → core）。审核暂存需要把它整体 JSON 持久化，
 * 故放 shared 而非 channels 层（历史库不能反向依赖通道实现）。
 */
export interface InboundEnvelope {
  message: ChatMessage
  chatName: string | null
  /** 群内消息是否 @ 了 bot 或回复了 bot（准入判定在 ChatManager 按绑定进行） */
  mentioned: boolean
}

export interface ChatInfo {
  channelId: string
  chatId: string
  name: string | null
  lastTs: number
}

/** 某会话中出现过的发送者（群成员白名单候选） */
export interface SenderInfo {
  id: string
  /** 最近一次发言时记录的显示名 */
  name: string | null
}

/**
 * 自动审核记录（智能 · 自动审核的历史与进度）。
 * running = 审核中；passed = 通过（放行）；rejected = 未通过（转人工审核）；error = 异常（转人工审核）。
 */
export type AutoReviewStatus = 'running' | 'passed' | 'rejected' | 'error'

export interface AutoReviewRecord {
  id: number
  channelId: string
  chatId: string
  senderId: string | null
  sender: string | null
  /** 待审核消息文本摘要 */
  text: string
  status: AutoReviewStatus
  /** 未通过/异常的原因；通过或审核中为 null */
  reason: string | null
  createdTs: number
  /** 完成判定时间；审核中为 null */
  decidedTs: number | null
}

/**
 * 定时任务的一次执行记录（task_runs 表）。
 * running = 执行中；ok = 完成（至少一个目标投递成功）；error = agent 失败/超时/全部投递失败。
 */
export type TaskRunStatus = 'running' | 'ok' | 'error'
export type TaskTrigger = 'schedule' | 'manual'

/** 单个目标的投递结果（随执行记录持久化） */
export interface TaskDelivery {
  channel: string
  chatId: string
  ok: boolean
  /** 失败原因；成功为 null */
  message: string | null
}

export interface TaskRunRecord {
  id: number
  taskId: string
  /** 任务名快照：任务删除/改名后历史仍可读 */
  taskName: string
  trigger: TaskTrigger
  status: TaskRunStatus
  /** agent 最终输出全文；失败或执行中为 null */
  result: string | null
  error: string | null
  deliveries: TaskDelivery[]
  startedTs: number
  finishedTs: number | null
}

/** 任务的运行时状态（合成，不落盘） */
export interface TaskStatus {
  taskId: string
  running: boolean
  /** 下次触发时间；已停用或表达式无解为 null */
  nextRunTs: number | null
  lastRun: TaskRunRecord | null
}

export type ChannelState = 'stopped' | 'starting' | 'running' | 'error'

export interface ChannelStatus {
  id: string
  state: ChannelState
  detail: string | null
}

/** agent 模型候选（main 枚举，UI 下拉 / /model 列表共用） */
export interface AgentModelOption {
  value: string
  name: string
  /** 模型一句话说明（来源不提供时缺省） */
  description?: string
}

/** Agent 安装态（Agent 管理页） */
/** agent 安装进度事件（codex 下载器与 ACP registry 共用） */
export interface AgentProgress {
  id: string
  phase: 'downloading' | 'extracting' | 'probing' | 'done' | 'error'
  detail: string | null
  /** downloading 阶段已接收字节数 */
  received?: number
  /** 总字节数；服务端未返回 content-length 时为 null */
  total?: number | null
}

/** 同构的 agent 安装态行（codex 与 ACP registry 同列，AgentManager.overview 聚合） */
export interface AgentInfo {
  id: string
  name: string
  description: string
  /** 本平台是否有可用分发 */
  installable: boolean
  installedVersion: string | null
  /** 可安装/更新到的版本（registry 版本 / codex 下载目标）；未知为 null */
  latestVersion: string | null
  /** 安装来源：installed=本地托管；dev/path=外部提供（不可卸载）；null=未安装 */
  source: 'installed' | 'dev' | 'path' | null
  /**
   * 是否支持 http 分发的 MCP server（susie 注入 send_message 的唯一方式）。
   * 安装时探测 initialize 的 mcpCapabilities.http；null = 未安装或探测失败（未知）。
   */
  mcpHttp: boolean | null
}

export type AgentsOverview = AgentInfo[]

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

/**
 * 自动更新状态机（对位 ChatGPT 的 idle/checking/ready/installing）。
 * 主进程 updater 归一化 electron-updater 事件后经 IPC 推给渲染层。
 */
export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; version: string; notes: string | null }
  | { status: 'not-available'; currentVersion: string }
  | {
      status: 'downloading'
      version: string
      percent: number
      bytesPerSecond: number
      transferred: number
      total: number
    }
  /** 已下载完成，等待重启安装 */
  | { status: 'ready'; version: string }
  | { status: 'error'; message: string }
