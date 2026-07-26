import { BrowserWindow } from 'electron'
import type { IpcEventSchema } from '../shared/ipc'

// invoke 通道已全部迁移到契约路由（shared/ipc/contract.ts + main/ipc/router.ts + main/ipc/handlers/）。
// 事件广播暂留此处，P3（类型化事件收官）迁入 WindowManager。

/** 向所有窗口推送事件 */
export function broadcast<K extends keyof IpcEventSchema>(channel: K, payload: IpcEventSchema[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}
