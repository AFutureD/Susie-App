import fs from 'node:fs'
import { app, type BrowserWindow } from 'electron'
import type { ConfigState } from '../shared/config'
import type { AppInfo } from '../shared/ipc/contract'
import { NAV_ROUTES } from '../shared/nav'
import type { ConfigStore } from './config/store'

export interface SmokeCheckDeps {
  showMainWindow: (options: { visible?: boolean }) => BrowserWindow
  /** 放行窗口关闭拦截（close→hide），让 app.quit() 真正退出 */
  markQuitting: () => void
}

/**
 * 冒烟自检（隐藏窗口，不打扰用户）：
 * 1. renderer 加载 + React 挂载；
 * 2. preload 桥 IPC 全链路（susie:app.getInfo / susie:config.get / susie:channels.statuses / susie:history.chats）；
 * 3. 配置热加载端到端：外部写 config.toml → chokidar → ConfigStore 生效。
 */
export async function runSmokeCheck(configStore: ConfigStore, deps: SmokeCheckDeps): Promise<void> {
  try {
    const win = deps.showMainWindow({ visible: false })
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve())
      win.webContents.once('did-fail-load', (_event, code, description) => {
        reject(new Error(`renderer load failed: ${code} ${description}`))
      })
    })

    const info = (await win.webContents.executeJavaScript(`window.susie.invoke('susie:app.getInfo')`)) as AppInfo
    if (typeof info?.electron !== 'string') {
      throw new Error(`unexpected app info: ${JSON.stringify(info)}`)
    }
    if (typeof info.mcpUrl !== 'string' || !info.mcpUrl.startsWith('http://127.0.0.1')) {
      throw new Error(`mcp server not running: ${String(info.mcpUrl)}`)
    }

    // 与 renderer 同源（shared/nav.ts）：加/删页面无需再改这里
    const navCount = (await win.webContents.executeJavaScript(`document.querySelectorAll('nav a').length`)) as number
    if (navCount !== NAV_ROUTES.length) {
      throw new Error(`react ui not mounted, nav items = ${navCount}`)
    }

    const configState = (await win.webContents.executeJavaScript(
      `window.susie.invoke('susie:config.get')`,
    )) as ConfigState
    if (typeof configState?.version !== 'number' || configState.config === undefined) {
      throw new Error(`unexpected config state: ${JSON.stringify(configState)}`)
    }

    const statuses = (await win.webContents.executeJavaScript(
      `window.susie.invoke('susie:channels.statuses')`,
    )) as unknown[]
    const chats = (await win.webContents.executeJavaScript(`window.susie.invoke('susie:history.chats')`)) as unknown[]
    if (!Array.isArray(statuses) || !Array.isArray(chats)) {
      throw new Error('service ipc not ready')
    }

    // 外部编辑（绕过 store 直接写盘）必须经 watcher 在 5 秒内生效
    const hotReloadObserved = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new Error('hot reload not observed within 5s'))
      }, 5000)
      const unsubscribe = configStore.onState((state) => {
        if (state.config.channels['smoke_bot'] !== undefined) {
          clearTimeout(timeout)
          unsubscribe()
          resolve()
        }
      })
    })
    const appended = `${configStore.readRawText()}\n[channels.smoke_bot]\ntype = "telegram_bot"\ntoken = "1:smoke"\nenabled = false\n`
    fs.writeFileSync(configStore.configPath, appended, 'utf-8')
    await hotReloadObserved

    console.log(
      `[smoke] ok — renderer mounted, ipc bridged (electron=${info.electron}), mcp=${info.mcpUrl}, config v${configState.version}, hot reload verified`,
    )
    deps.markQuitting()
    app.quit()
  } catch (error) {
    console.error('[smoke] failed:', error)
    app.exit(1)
  }
}
