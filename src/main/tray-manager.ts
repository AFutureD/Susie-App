import { Menu, Tray, nativeImage } from 'electron'
import { TRAY_ICON_16, TRAY_ICON_32 } from './tray-icon'

export interface TrayManagerDeps {
  showMainWindow: () => void
  /** 真退出（放行窗口关闭拦截后 app.quit()） */
  quit: () => void
}

function createTrayImage(): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  image.addRepresentation({ scaleFactor: 1, dataURL: TRAY_ICON_16 })
  image.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_32 })
  image.setTemplateImage(true)
  return image
}

export class TrayManager {
  /** 持有引用防止 GC 后图标消失 */
  private tray: Tray | null = null

  constructor(private readonly deps: TrayManagerDeps) {}

  create(): void {
    const tray = new Tray(createTrayImage())
    tray.setToolTip('Susie')

    const menu = Menu.buildFromTemplate([
      { label: '打开 Susie', click: () => this.deps.showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => this.deps.quit() },
    ])
    tray.setContextMenu(menu)
    this.tray = tray
  }

  destroy(): void {
    this.tray?.destroy()
    this.tray = null
  }
}
