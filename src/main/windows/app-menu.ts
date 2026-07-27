import { Menu, type MenuItemConstructorOptions } from 'electron'
import { isDev } from '../env'

/**
 * 顶部应用菜单（macOS menu bar）。显式设置而非依赖 Electron 默认菜单：
 * 菜单栏常驻应用在 dock.hide()（Accessory）⇄ dock.show()（Regular）切换后，
 * 默认菜单可能不再回挂；显式设置与恢复顺序修正（WindowManager.showWithDock）互为保险。
 * Edit 菜单缺失时 Cmd+C/V 等快捷键也会失效，必须常备。
 */
export function installAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    ...(isDev ? ([{ role: 'viewMenu' }] satisfies MenuItemConstructorOptions[]) : []),
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
