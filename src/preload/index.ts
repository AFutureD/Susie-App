import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENT_CHANNELS } from '../shared/ipc'
import type { SusieGenericBridge } from '../shared/ipc/bridge'
import { EVENT_PREFIX, INVOKE_PREFIX } from '../shared/ipc/channel'
import { isErrorEnvelope, reviveError } from '../shared/ipc/envelope'

// 门卫：invoke 按 susie: 前缀放行——契约由「main 路由按 typeof ipcContract 注册」与
// 「renderer 客户端受 IpcClient 约束」两端锁死，preload 不再维护通道清单。
// 事件白名单 Set 在 P3（事件迁移 susie-evt: 前缀）后删除。
const legacyEventChannels: ReadonlySet<string> = new Set(IPC_EVENT_CHANNELS)

const bridge: SusieGenericBridge = {
  invoke: async (channel, payload) => {
    if (!channel.startsWith(INVOKE_PREFIX)) {
      throw new Error(`unknown ipc invoke channel: ${channel}`)
    }
    const result: unknown = await ipcRenderer.invoke(channel, payload)
    // 主进程路由把异常转成结构化信封（Electron 原生抛错会丢 cause/code），此处还原成真 Error
    if (isErrorEnvelope(result)) throw reviveError(result)
    return result
  },

  on: (channel, listener) => {
    if (!channel.startsWith(EVENT_PREFIX) && !legacyEventChannels.has(channel)) {
      throw new Error(`unknown ipc event channel: ${channel}`)
    }
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.off(channel, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('susie', bridge)
