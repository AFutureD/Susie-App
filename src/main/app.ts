import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'
import { getConfigPath } from './config/paths'
import { ConfigStore } from './config/store'
import { watchConfigFile } from './config/watcher'
import { appFlags, isDev } from './env'
import { buildIpcHandlers } from './ipc/handlers'
import { registerIpcRouter } from './ipc/router'
import { serviceLogger, setupLogging } from './logging'
import { SusieService } from './service'
import { runSmokeCheck } from './smoke'
import { TrayManager } from './tray-manager'
import { UpdaterManager } from './updater-manager'
import { withTimeout } from './util/async'
import { mergeLoginShellPath } from './util/shell-path'
import { installAppMenu } from './windows/app-menu'
import { WindowManager } from './windows/window-manager'

/**
 * 组合根：装配 ConfigStore / SusieService / 窗口 / 托盘 / 更新器，编排启动与停机。
 * 只做装配与编排——业务逻辑住在 service 与各子系统里。
 */
export class App {
  readonly configStore: ConfigStore
  readonly windows: WindowManager
  readonly tray: TrayManager
  readonly updater: UpdaterManager
  readonly service: SusieService

  /** 真退出标记（close→hide 拦截据此放行）；原 lifecycle.quitting */
  isQuitting = false

  private serviceStopped = false
  private readonly shellPathMerged: Promise<unknown>

  constructor() {
    app.setName('Susie')
    setupLogging()

    // GUI 启动只继承 launchd 最小 PATH，npx 分发的 ACP agent 会 spawn ENOENT——
    // 尽早并行解析 login shell PATH，whenReady 后合并完成再注册 IPC/启动 service
    this.shellPathMerged = mergeLoginShellPath(serviceLogger)

    this.windows = new WindowManager({ isQuitting: () => this.isQuitting })
    this.tray = new TrayManager({
      showMainWindow: () => {
        this.windows.showMainWindow()
      },
      quit: () => {
        this.isQuitting = true
        app.quit()
      },
    })
    this.updater = new UpdaterManager({
      onState: (state) => this.windows.broadcast('update.state', state),
      setQuitting: (quitting) => {
        this.isQuitting = quitting
      },
    })

    this.configStore = ConfigStore.init(getConfigPath())
    // 配置热加载失败只体现在 state.lastError（last-good 降级），必须留日志痕迹
    // 初值取启动时的 lastError——启动错误由 whenReady 里的 config error 日志负责，避免重复
    let lastLoggedConfigError: string | null = this.configStore.state().lastError
    this.configStore.onState((state) => {
      this.windows.broadcast('config.state', state)
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
      (event, payload) => this.windows.broadcast(event, payload),
      serviceLogger,
    )
  }

  /** 挂接 app 生命周期事件并启动（构造后调用一次） */
  bootstrap(): void {
    app.on('second-instance', () => {
      this.windows.showMainWindow()
    })

    app.on('activate', () => {
      this.windows.showMainWindow()
    })

    app.on('window-all-closed', () => {
      // 菜单栏常驻：不随窗口关闭退出
    })

    app.on('before-quit', () => {
      this.isQuitting = true
    })

    app.on('quit', () => {
      log.info('app quit')
    })

    app.on('will-quit', (event) => {
      log.info(`will-quit (serviceStopped=${this.serviceStopped})`)
      if (this.serviceStopped) return
      event.preventDefault()
      this.updater.dispose()
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
        buildIpcHandlers({
          getMcpUrl: () => this.service.mcp.url,
          config: this.configStore,
          service: this.service,
          updater: this.updater,
        }),
        serviceLogger,
      )
      installAppMenu()
      this.updater.init()
      this.tray.create()
      watchConfigFile(this.configStore, serviceLogger)

      if (appFlags.headless) {
        this.windows.updateDockVisibility()
      } else {
        this.windows.showMainWindow()
      }

      const state = this.configStore.state()
      log.info(`Susie started (version=${app.getVersion()}, dev=${isDev}, headless=${appFlags.headless})`)
      log.info(`config: ${state.configPath} (v${state.version}, channels=${Object.keys(state.config.channels).length})`)
      if (state.lastError) log.error(`config error: ${state.lastError}`)

      await this.service.start()

      if (appFlags.smoke) {
        void runSmokeCheck(this.configStore, {
          showMainWindow: (options) => this.windows.showMainWindow(options),
          markQuitting: () => {
            this.isQuitting = true
          },
        })
      }
    })
  }
}
