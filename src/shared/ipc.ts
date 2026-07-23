// 主进程 ↔ 渲染进程的 IPC 契约。三端（main/preload/renderer）共享此文件。
// 新增通道：在 Schema 里加类型，并同步登记到下方的通道清单（preload 按清单做运行时白名单）。

import type { AssistantConfig, ChannelSettings, ChatBinding, ConfigMutationResult, ConfigState } from './config'
import type { AgentProgress, AgentsOverview, ChannelStatus, ChatInfo, StoredMessage } from './messages'

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
  'config:upsert-binding': {
    req: { index: number | null; binding: ChatBinding; expectedVersion: number }
    res: ConfigMutationResult
  }
  'config:delete-binding': { req: { index: number; expectedVersion: number }; res: ConfigMutationResult }
  'config:move-binding': {
    req: { index: number; direction: 'up' | 'down'; expectedVersion: number }
    res: ConfigMutationResult
  }
  'config:preview-template': {
    req: { template: string }
    res: { ok: true; rendered: string } | { ok: false; message: string }
  }

  'channel:statuses': { req: undefined; res: ChannelStatus[] }

  'history:chats': { req: undefined; res: ChatInfo[] }
  'history:messages': {
    req: { channelId: string; chatId: string; limit?: number; beforeId?: number }
    res: StoredMessage[]
  }
  'history:search': { req: { q: string; limit?: number }; res: StoredMessage[] }
  'chat:send': { req: { channelId: string; chatId: string; text: string }; res: ActionResult }

  'agents:overview': { req: undefined; res: AgentsOverview }
  'agents:install': { req: { id: string }; res: ActionResult }
  'agents:uninstall': { req: { id: string }; res: ActionResult }

  'logs:tail': { req: { lines?: number; file?: 'main' | 'error' }; res: { path: string; lines: string[] } }
}

export const IPC_INVOKE_CHANNELS = [
  'app:get-info',
  'app:set-login-item',
  'dialog:pick-directory',
  'config:get',
  'config:get-raw',
  'config:save-raw',
  'config:upsert-channel',
  'config:delete-channel',
  'config:upsert-assistant',
  'config:delete-assistant',
  'config:upsert-binding',
  'config:delete-binding',
  'config:move-binding',
  'config:preview-template',
  'channel:statuses',
  'history:chats',
  'history:messages',
  'history:search',
  'chat:send',
  'agents:overview',
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
