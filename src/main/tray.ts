import { Menu, Tray, app, nativeImage } from 'electron'
import { lifecycle } from './lifecycle'
import { TRAY_ICON_16, TRAY_ICON_32 } from './tray-icon'
import { showMainWindow } from './window'

// 持有引用防止 GC 后图标消失
let tray: Tray | null = null

function createTrayImage(): Electron.NativeImage {
  const image = nativeImage.createEmpty()
  image.addRepresentation({ scaleFactor: 1, dataURL: TRAY_ICON_16 })
  image.addRepresentation({ scaleFactor: 2, dataURL: TRAY_ICON_32 })
  image.setTemplateImage(true)
  return image
}

export function createTray(): Tray {
  tray = new Tray(createTrayImage())
  tray.setToolTip('Susie')

  const menu = Menu.buildFromTemplate([
    { label: '打开 Susie', click: () => void showMainWindow() },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        lifecycle.quitting = true
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)

  return tray
}
