// 主进程 → 渲染进程的事件契约（invoke 契约已全部迁往 shared/ipc/contract.ts）。
// 本文件剩余的事件部分在 P3（类型化事件收官）迁往 shared/ipc/events.ts 后删除。

import type { ConfigState } from './config'
import type { AgentProgress, AutoReviewRecord, ChannelStatus, StoredMessage, UpdateState } from './messages'

// AppInfo / ActionResult 已迁入契约（shared/ipc/contract.ts）；此处 re-export 供旧引用过渡。
export type { ActionResult, AppInfo } from './ipc/contract'

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

/** preload 暴露到 window.susie 的事件订阅签名（invoke 走 shared/ipc/bridge.ts 的泛型桥） */
export interface SusieBridge {
  on<K extends keyof IpcEventSchema>(channel: K, listener: (payload: IpcEventSchema[K]) => void): () => void
}
