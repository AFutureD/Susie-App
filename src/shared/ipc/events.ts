// 主进程 → 渲染进程的事件契约（type-only：事件由可信主进程生产，不做运行时校验）。
// 事件名与通道的关系：`susie-evt:<name>`（见 channel.ts 的 eventChannel）。
// 发送端 WindowManager.broadcast 与接收端 onIpcEvent/useIpcEvent 都由本表约束——
// 新增事件 = 此处加一行，两端类型立即生效。

import type { ConfigState } from '../config'
import type {
  AgentProgress,
  AutoReviewRecord,
  ChannelStatus,
  StoredMessage,
  TaskRunRecord,
  UpdateState,
} from '../messages'

export interface IpcEvents {
  'config.state': ConfigState
  'channels.status': ChannelStatus[]
  'history.message': StoredMessage
  'agents.progress': AgentProgress
  /** 自动审核记录新增/状态更新（按 id 去重合并） */
  'autoReview.record': AutoReviewRecord
  /** 定时任务执行记录新增/状态更新（按 id 去重合并） */
  'tasks.run': TaskRunRecord
  /** 自动更新状态推送 */
  'update.state': UpdateState
}

/** 主进程侧的类型化广播签名（实现在 WindowManager） */
export type IpcBroadcaster = <K extends keyof IpcEvents>(event: K, payload: IpcEvents[K]) => void
