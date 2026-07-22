import { contextBridge, ipcRenderer } from 'electron'
import { IPC_EVENT_CHANNELS, IPC_INVOKE_CHANNELS, type SusieBridge } from '../shared/ipc'

const invokeChannels: ReadonlySet<string> = new Set(IPC_INVOKE_CHANNELS)
const eventChannels: ReadonlySet<string> = new Set(IPC_EVENT_CHANNELS)

const bridge: SusieBridge = {
  invoke: ((channel: string, ...args: unknown[]) => {
    if (!invokeChannels.has(channel)) {
      return Promise.reject(new Error(`unknown ipc invoke channel: ${channel}`))
    }
    return ipcRenderer.invoke(channel, args[0])
  }) as SusieBridge['invoke'],

  on: ((channel: string, listener: (payload: unknown) => void) => {
    if (!eventChannels.has(channel)) {
      throw new Error(`unknown ipc event channel: ${channel}`)
    }
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.off(channel, wrapped)
    }
  }) as SusieBridge['on'],
}

contextBridge.exposeInMainWorld('susie', bridge)
