import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'
import type { ConfigState } from '../shared/config'
import type { AppInfo } from '../shared/ipc'
import { getConfigPath } from './config/paths'
import { ConfigStore } from './config/store'
import { watchConfigFile } from './config/watcher'
import { appFlags, isDev } from './env'
import { broadcast, registerIpcHandlers } from './ipc'
import { lifecycle } from './lifecycle'
import { SusieService } from './service'
import { createTray } from './tray'
import { withTimeout } from './util/async'
import { showMainWindow, updateDockVisibility } from './window'

// 测试/冒烟隔离：userData 可被环境变量覆盖（须在单实例锁之前设置——锁按 userData 计算）
const userDataOverride = process.env['SUSIE_USER_DATA_DIR']
if (userDataOverride && userDataOverride !== '') {
  app.setPath('userData', userDataOverride)
}

// 同一 userData 只允许一个实例（双开会导致 Telegram polling 409 互踢）
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.setName('Susie')
  log.initialize()
  log.transports.file.level = 'info'
  log.errorHandler.startCatching()

  const configStore = ConfigStore.init(getConfigPath())
  configStore.onState((state) => broadcast('config:state', state))

  const userData = app.getPath('userData')
  const service = new SusieService(
    configStore,
    {
      historyDb: path.join(userData, 'history.db'),
      attachmentsDir: path.join(userData, 'attachments'),
      acpDataDir: path.join(userData, 'acp'),
    },
    {
      channelStatuses: (statuses) => broadcast('channel:status', statuses),
      historyMessage: (message) => broadcast('history:message', message),
      agentsProgress: (progress) => broadcast('agents:progress', progress),
    },
    (message) => log.info(message),
  )

  let serviceStopped = false

  app.on('second-instance', () => {
    showMainWindow()
  })

  app.on('activate', () => {
    showMainWindow()
  })

  app.on('window-all-closed', () => {
    // 菜单栏常驻：不随窗口关闭退出
  })

  app.on('before-quit', () => {
    lifecycle.quitting = true
  })

  app.on('quit', () => {
    log.info('app quit')
  })

  app.on('will-quit', (event) => {
    log.info(`will-quit (serviceStopped=${serviceStopped})`)
    if (serviceStopped) return
    event.preventDefault()
    // 退出必须有硬上限：网络/子进程都不允许阻塞 quit
    void withTimeout(
      service.stop().catch(() => {}),
      5000,
      undefined,
    ).finally(() => {
      serviceStopped = true
      // service.stop() 可能在微任务内就完成，此时仍处于 will-quit 分发栈中，
      // 重入 app.quit() 会被吞掉——必须推迟到下一个 tick。
      setImmediate(() => app.quit())
    })
  })

  void app.whenReady().then(async () => {
    registerIpcHandlers(configStore, service)
    createTray()
    watchConfigFile(configStore)

    if (appFlags.headless) {
      updateDockVisibility()
    } else {
      showMainWindow()
    }

    const state = configStore.state()
    log.info(`Susie started (version=${app.getVersion()}, dev=${isDev}, headless=${appFlags.headless})`)
    log.info(`config: ${state.configPath} (v${state.version}, channels=${Object.keys(state.config.channels).length})`)
    if (state.lastError) log.warn(`config error: ${state.lastError}`)
    for (const note of state.migrations) log.warn(`config migration: ${note}`)

    await service.start()

    if (appFlags.smoke) {
      void runSmokeCheck(configStore)
    }
  })
}

/**
 * 冒烟自检（隐藏窗口，不打扰用户）：
 * 1. renderer 加载 + React 挂载；
 * 2. preload 桥 IPC 全链路（app:get-info / config:get / channel:statuses / history:chats）；
 * 3. 配置热加载端到端：外部写 config.toml → chokidar → ConfigStore 生效。
 */
async function runSmokeCheck(configStore: ConfigStore): Promise<void> {
  try {
    const win = showMainWindow({ visible: false })
    await new Promise<void>((resolve, reject) => {
      win.webContents.once('did-finish-load', () => resolve())
      win.webContents.once('did-fail-load', (_event, code, description) => {
        reject(new Error(`renderer load failed: ${code} ${description}`))
      })
    })

    const info = (await win.webContents.executeJavaScript(`window.susie.invoke('app:get-info')`)) as AppInfo
    if (typeof info?.electron !== 'string') {
      throw new Error(`unexpected app info: ${JSON.stringify(info)}`)
    }
    if (typeof info.mcpUrl !== 'string' || !info.mcpUrl.startsWith('http://127.0.0.1')) {
      throw new Error(`mcp server not running: ${String(info.mcpUrl)}`)
    }

    const navCount = (await win.webContents.executeJavaScript(`document.querySelectorAll('nav a').length`)) as number
    if (navCount !== 6) {
      throw new Error(`react ui not mounted, nav items = ${navCount}`)
    }

    const configState = (await win.webContents.executeJavaScript(`window.susie.invoke('config:get')`)) as ConfigState
    if (typeof configState?.version !== 'number' || configState.config === undefined) {
      throw new Error(`unexpected config state: ${JSON.stringify(configState)}`)
    }

    const statuses = (await win.webContents.executeJavaScript(`window.susie.invoke('channel:statuses')`)) as unknown[]
    const chats = (await win.webContents.executeJavaScript(`window.susie.invoke('history:chats')`)) as unknown[]
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
    lifecycle.quitting = true
    app.quit()
  } catch (error) {
    console.error('[smoke] failed:', error)
    app.exit(1)
  }
}
