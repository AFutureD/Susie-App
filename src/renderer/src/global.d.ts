import type { SusieBridge } from '../../shared/ipc'
import type { SusieGenericBridge } from '../../shared/ipc/bridge'

declare global {
  interface Window {
    /** preload 注入的 IPC 桥：泛型收发 + 旧类型化签名（逐域迁移期间共存） */
    susie: SusieBridge & SusieGenericBridge
  }
}

export {}
