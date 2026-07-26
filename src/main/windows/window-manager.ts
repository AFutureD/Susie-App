import path from 'node:path'
import { BrowserWindow, app } from 'electron'
import type { IpcEventSchema } from '../../shared/ipc'
import { devServerUrl } from '../env'

export interface WindowManagerDeps {
  /** 真退出时放行 close（否则 close→hide 常驻菜单栏） */
  isQuitting: () => boolean
}

/** 主窗口生命周期 + Dock 可见性 + 向渲染进程广播事件（窗口集合的所有者） */
export class WindowManager {
  private win: BrowserWindow | null = null

  constructor(private readonly deps: WindowManagerDeps) {}

  /** 菜单栏常驻应用：窗口可见时才显示 Dock 图标。 */
  updateDockVisibility(): void {
    const visible = this.win !== null && !this.win.isDestroyed() && this.win.isVisible()
    if (visible) {
      void app.dock?.show()
    } else {
      app.dock?.hide()
    }
  }

  showMainWindow(options: { visible?: boolean } = {}): BrowserWindow {
    const { visible = true } = options

    if (this.win && !this.win.isDestroyed()) {
      if (visible) {
        this.win.show()
        this.win.focus()
        this.updateDockVisibility()
      }
      return this.win
    }

    const win = new BrowserWindow({
      width: 1120,
      height: 740,
      minWidth: 840,
      minHeight: 560,
      show: false,
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        preload: path.join(import.meta.dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })
    this.win = win

    win.on('ready-to-show', () => {
      if (!visible) return
      win.show()
      this.updateDockVisibility()
    })

    win.on('close', (event) => {
      if (this.deps.isQuitting()) return
      event.preventDefault()
      win.hide()
      this.updateDockVisibility()
    })

    win.on('closed', () => {
      if (this.win === win) this.win = null
    })

    if (devServerUrl) {
      void win.loadURL(devServerUrl)
    } else {
      void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
    }

    return win
  }

  /** 向所有窗口推送事件 */
  broadcast<K extends keyof IpcEventSchema>(channel: K, payload: IpcEventSchema[K]): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }
}
