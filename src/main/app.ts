import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'
import { getConfigPath } from './config/paths'
import { ConfigStore } from './config/store'
import { watchConfigFile } from './config/watcher'
import { appFlags, isDev } from './env'
import { broadcast } from './ipc'
import { buildIpcHandlers } from './ipc/handlers'
import { registerIpcRouter } from './ipc/router'
import { lifecycle } from './lifecycle'
import { serviceLogger, setupLogging } from './logging'
import { SusieService } from './service'
import { runSmokeCheck } from './smoke'
import { createTray } from './tray'
import { initUpdater } from './updater'
import { withTimeout } from './util/async'
import { mergeLoginShellPath } from './util/shell-path'
import { showMainWindow, updateDockVisibility } from './window'

/**
 * 组合根：装配 ConfigStore / SusieService / 窗口 / 托盘 / 更新器，编排启动与停机。
 * 只做装配与编排——业务逻辑住在 service 与各子系统里。
 */
export class App {
  readonly configStore: ConfigStore
  readonly service: SusieService

  private serviceStopped = false
  private readonly shellPathMerged: Promise<unknown>

  constructor() {
    app.setName('Susie')
    setupLogging()

    // GUI 启动只继承 launchd 最小 PATH，npx 分发的 ACP agent 会 spawn ENOENT——
    // 尽早并行解析 login shell PATH，whenReady 后合并完成再注册 IPC/启动 service
    this.shellPathMerged = mergeLoginShellPath(serviceLogger)

    this.configStore = ConfigStore.init(getConfigPath())
    // 配置热加载失败只体现在 state.lastError（last-good 降级），必须留日志痕迹
    // 初值取启动时的 lastError——启动错误由 whenReady 里的 config error 日志负责，避免重复
    let lastLoggedConfigError: string | null = this.configStore.state().lastError
    this.configStore.onState((state) => {
      broadcast('config:state', state)
      if (state.lastError !== null && state.lastError !== lastLoggedConfigError) {
        log.error(`config 加载失败（沿用 last-good 配置）：${state.lastError}`)
      }
      lastLoggedConfigError = state.lastError
    })

    const userData = app.getPath('userData')
    this.service = new SusieService(
      this.configStore,
      {
        historyDb: path.join(userData, 'history.db'),
        attachmentsDir: path.join(userData, 'attachments'),
        acpDataDir: path.join(userData, 'acp'),
        codexDataDir: path.join(userData, 'codex'),
      },
      {
        channelStatuses: (statuses) => broadcast('channel:status', statuses),
        historyMessage: (message) => broadcast('history:message', message),
        agentsProgress: (progress) => broadcast('agents:progress', progress),
        autoReview: (record) => broadcast('autoreview:record', record),
      },
      serviceLogger,
    )
  }

  /** 挂接 app 生命周期事件并启动（构造后调用一次） */
  bootstrap(): void {
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
      log.info(`will-quit (serviceStopped=${this.serviceStopped})`)
      if (this.serviceStopped) return
      event.preventDefault()
      // 退出必须有硬上限：网络/子进程都不允许阻塞 quit
      void withTimeout(
        this.service.stop().catch(() => {}),
        5000,
        undefined,
      ).finally(() => {
        this.serviceStopped = true
        // service.stop() 可能在微任务内就完成，此时仍处于 will-quit 分发栈中，
        // 重入 app.quit() 会被吞掉——必须推迟到下一个 tick。
        setImmediate(() => app.quit())
      })
    })

    void app.whenReady().then(async () => {
      await this.shellPathMerged
      registerIpcRouter(
        buildIpcHandlers({ getMcpUrl: () => this.service.mcp.url, config: this.configStore, service: this.service }),
        serviceLogger,
      )
      initUpdater((state) => broadcast('update:state', state))
      createTray()
      watchConfigFile(this.configStore, serviceLogger)

      if (appFlags.headless) {
        updateDockVisibility()
      } else {
        showMainWindow()
      }

      const state = this.configStore.state()
      log.info(`Susie started (version=${app.getVersion()}, dev=${isDev}, headless=${appFlags.headless})`)
      log.info(`config: ${state.configPath} (v${state.version}, channels=${Object.keys(state.config.channels).length})`)
      if (state.lastError) log.error(`config error: ${state.lastError}`)

      await this.service.start()

      if (appFlags.smoke) {
        void runSmokeCheck(this.configStore, {
          showMainWindow,
          markQuitting: () => {
            lifecycle.quitting = true
          },
        })
      }
    })
  }
}
