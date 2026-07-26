// 主进程 ↔ 渲染进程的 IPC 契约。三端（main/preload/renderer）共享此文件。
// 新增通道：在 Schema 里加类型，并同步登记到下方的通道清单（preload 按清单做运行时白名单）。

import type {
  AssistantConfig,
  AutoReviewConfig,
  ChannelSettings,
  ChannelUser,
  ChatBinding,
  ConfigMutationResult,
  ConfigState,
} from './config'
import type {
  AgentModelOption,
  AgentProgress,
  AgentsOverview,
  AutoReviewRecord,
  ChannelStatus,
  ChatInfo,
  SenderInfo,
  StoredMessage,
  UpdateState,
} from './messages'

// AppInfo / ActionResult 已迁入契约（shared/ipc/contract.ts）；此处 re-export 供旧引用过渡。
export type { ActionResult, AppInfo } from './ipc/contract'
import type { ActionResult } from './ipc/contract'

/** invoke（请求/响应）通道（逐域迁往 shared/ipc/contract.ts，迁完删除） */
export interface IpcInvokeSchema {
  'agents:overview': { req: undefined; res: AgentsOverview }
  /** 枚举指定 agent 的模型候选；agent 未安装或枚举失败返回 [] */
  'agents:models': { req: { agentId: string }; res: AgentModelOption[] }
  'agents:install': { req: { id: string }; res: ActionResult }
  'agents:uninstall': { req: { id: string }; res: ActionResult }

  'logs:tail': { req: { lines?: number; file?: 'main' | 'error' }; res: { path: string; lines: string[] } }

  /** 智能 · 自动审核的历史与进度（新 → 旧） */
  'autoreview:list': { req: { limit?: number }; res: AutoReviewRecord[] }

  /** 手动触发检查更新（dev/未打包时返回 not-ok） */
  'update:check': { req: undefined; res: ActionResult }
  /** 立即重启并安装已下载的更新 */
  'update:install': { req: undefined; res: ActionResult }
  /** 拉取当前更新状态快照（新窗口订阅前回填） */
  'update:get-state': { req: undefined; res: UpdateState }
}

export const IPC_INVOKE_CHANNELS = [
  'agents:overview',
  'agents:models',
  'agents:install',
  'agents:uninstall',
  'logs:tail',
  'autoreview:list',
  'update:check',
  'update:install',
  'update:get-state',
] as const satisfies readonly (keyof IpcInvokeSchema)[]

/** 事件（主进程 → 渲染进程推送）通道 */
export interface IpcEventSchema {
  'config:state': ConfigState
  'channel:status': ChannelStatus[]
  'history:message': StoredMessage
  'agents:progress': AgentProgress
  /** 自动审核记录新增/状态更新（按 id 去重合并） */
  'autoreview:record': AutoReviewRecord
  /** 自动更新状态推送 */
  'update:state': UpdateState
}

export const IPC_EVENT_CHANNELS = [
  'config:state',
  'channel:status',
  'history:message',
  'agents:progress',
  'autoreview:record',
  'update:state',
] as const satisfies readonly (keyof IpcEventSchema)[]

/** req 为 undefined 的通道，调用时省略 payload 参数。 */
export type InvokeArgs<K extends keyof IpcInvokeSchema> = IpcInvokeSchema[K]['req'] extends undefined
  ? []
  : [payload: IpcInvokeSchema[K]['req']]

/** preload 暴露到 window.susie 的桥接口 */
export interface SusieBridge {
  invoke<K extends keyof IpcInvokeSchema>(channel: K, ...args: InvokeArgs<K>): Promise<IpcInvokeSchema[K]['res']>
  on<K extends keyof IpcEventSchema>(channel: K, listener: (payload: IpcEventSchema[K]) => void): () => void
}
