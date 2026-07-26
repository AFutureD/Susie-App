import type { SusieGenericBridge } from '../../shared/ipc/bridge'

declare global {
  interface Window {
    /** preload 注入的 IPC 泛型桥（类型化封装见 lib/ipc.ts） */
    susie: SusieGenericBridge
  }
}

export {}
