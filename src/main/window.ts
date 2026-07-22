import path from 'node:path'
import { BrowserWindow, app } from 'electron'
import { devServerUrl } from './env'
import { lifecycle } from './lifecycle'

let win: BrowserWindow | null = null

/** 菜单栏常驻应用：窗口可见时才显示 Dock 图标。 */
export function updateDockVisibility(): void {
  const visible = win !== null && !win.isDestroyed() && win.isVisible()
  if (visible) {
    void app.dock?.show()
  } else {
    app.dock?.hide()
  }
}

export function showMainWindow(options: { visible?: boolean } = {}): BrowserWindow {
  const { visible = true } = options

  if (win && !win.isDestroyed()) {
    if (visible) {
      win.show()
      win.focus()
      updateDockVisibility()
    }
    return win
  }

  win = new BrowserWindow({
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

  win.on('ready-to-show', () => {
    if (!visible) return
    win?.show()
    updateDockVisibility()
  })

  win.on('close', (event) => {
    if (lifecycle.quitting) return
    event.preventDefault()
    win?.hide()
    updateDockVisibility()
  })

  win.on('closed', () => {
    win = null
  })

  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    void win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }

  return win
}
