import { contextBridge, ipcRenderer } from 'electron'
import type { SusieGenericBridge } from '../shared/ipc/bridge'
import { EVENT_PREFIX, INVOKE_PREFIX } from '../shared/ipc/channel'
import { isErrorEnvelope, reviveError } from '../shared/ipc/envelope'

// 门卫：只放行 susie 命名空间（susie:* invoke / susie-evt:* 事件），渲染进程够不到 Electron 内部通道。
// preload 不维护通道清单——契约由「main 路由按 typeof ipcContract 注册」与
// 「renderer 客户端受 IpcClient / IpcEvents 类型约束」两端锁死，不存在第三份清单。
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
    if (!channel.startsWith(EVENT_PREFIX)) {
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
