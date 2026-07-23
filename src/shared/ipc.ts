// 主进程 ↔ 渲染进程的 IPC 契约。三端（main/preload/renderer）共享此文件。
// 新增通道：在 Schema 里加类型，并同步登记到下方的通道清单（preload 按清单做运行时白名单）。

import type { AssistantConfig, ChannelSettings, ChatBinding, ConfigMutationResult, ConfigState } from './config'
import type {
  AgentModelOption,
  AgentProgress,
  AgentsOverview,
  ChannelStatus,
  ChatInfo,
  SenderInfo,
  StoredMessage,
} from './messages'

export interface AppInfo {
  name: string
  version: string
  electron: string
  chrome: string
  node: string
  platform: string
  headless: boolean
  loginItemEnabled: boolean
  mcpUrl: string | null
}

export type ActionResult = { ok: true } | { ok: false; message: string }

/** invoke（请求/响应）通道 */
export interface IpcInvokeSchema {
  'app:get-info': { req: undefined; res: AppInfo }
  'app:set-login-item': { req: { enabled: boolean }; res: ActionResult }
  /** 在系统默认浏览器/对应 App 打开外部链接（仅 https） */
  'app:open-external': { req: { url: string }; res: ActionResult }
  'dialog:pick-directory': { req: undefined; res: string | null }

  'config:get': { req: undefined; res: ConfigState }
  'config:get-raw': { req: undefined; res: { text: string; version: number } }
  'config:save-raw': { req: { text: string; expectedVersion: number }; res: ConfigMutationResult }
  'config:upsert-channel': {
    req: { id: string; settings: ChannelSettings; expectedVersion: number }
    res: ConfigMutationResult
  }
  'config:delete-channel': { req: { id: string; expectedVersion: number }; res: ConfigMutationResult }
  'config:upsert-assistant': { req: { assistant: AssistantConfig; expectedVersion: number }; res: ConfigMutationResult }
  'config:delete-assistant': { req: { id: string; expectedVersion: number }; res: ConfigMutationResult }
  /** 整组替换 bindings（节点编辑器是全量状态编辑，index 式 API 不适配） */
  'config:set-bindings': { req: { bindings: ChatBinding[]; expectedVersion: number }; res: ConfigMutationResult }

  /** 在 Finder 打开 assistant 的生效工作目录（缺省为 workspace/<id>，会自动创建） */
  'assistants:open-workdir': { req: { id: string }; res: ActionResult }

  'channel:statuses': { req: undefined; res: ChannelStatus[] }
  /** 用 token 调 getMe 拿 bot username（频道 ID 留空时自动命名） */
  'channels:resolve-username': {
    req: { token: string }
    res: { ok: true; username: string } | { ok: false; message: string }
  }

  'history:chats': { req: undefined; res: ChatInfo[] }
  /** 出现过的发送者（白名单候选）；chatId 省略时跨该频道全部会话 */
  'history:senders': { req: { channelId: string; chatId?: string }; res: SenderInfo[] }
  'history:messages': {
    req: { channelId: string; chatId: string; limit?: number; beforeId?: number }
    res: StoredMessage[]
  }
  'history:search': { req: { q: string; limit?: number }; res: StoredMessage[] }
  'chat:send': { req: { channelId: string; chatId: string; text: string }; res: ActionResult }

  'agents:overview': { req: undefined; res: AgentsOverview }
  /** 枚举指定 agent 的模型候选；agent 未安装或枚举失败返回 [] */
  'agents:models': { req: { agentId: string }; res: AgentModelOption[] }
  'agents:install': { req: { id: string }; res: ActionResult }
  'agents:uninstall': { req: { id: string }; res: ActionResult }

  'logs:tail': { req: { lines?: number; file?: 'main' | 'error' }; res: { path: string; lines: string[] } }
}

export const IPC_INVOKE_CHANNELS = [
  'app:get-info',
  'app:set-login-item',
  'app:open-external',
  'dialog:pick-directory',
  'config:get',
  'config:get-raw',
  'config:save-raw',
  'config:upsert-channel',
  'config:delete-channel',
  'config:upsert-assistant',
  'config:delete-assistant',
  'config:set-bindings',
  'assistants:open-workdir',
  'channel:statuses',
  'channels:resolve-username',
  'history:chats',
  'history:senders',
  'history:messages',
  'history:search',
  'chat:send',
  'agents:overview',
  'agents:models',
  'agents:install',
  'agents:uninstall',
  'logs:tail',
] as const satisfies readonly (keyof IpcInvokeSchema)[]

/** 事件（主进程 → 渲染进程推送）通道 */
export interface IpcEventSchema {
  'config:state': ConfigState
  'channel:status': ChannelStatus[]
  'history:message': StoredMessage
  'agents:progress': AgentProgress
}

export const IPC_EVENT_CHANNELS = [
  'config:state',
  'channel:status',
  'history:message',
  'agents:progress',
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
