// 自动更新（electron-updater / GitHub Releases）。
// 与现有打包链路对接：electron-builder 的 publish 配置在打包时生成 app-update.yml 与 latest-mac.yml，
// macOS 走 Squirrel.Mac，校验新包的 Developer ID 代码签名后由独立进程替换并重启。
// 事件被归一化为 UpdateState（对位 ChatGPT 的 idle/checking/ready/installing）经 IPC 推给渲染层。

import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'
import electronUpdater, { type ProgressInfo, type UpdateInfo } from 'electron-updater'
import { errorMessage } from '../shared/errors'
import type { ActionResult } from '../shared/ipc'
import type { UpdateState } from '../shared/messages'
import { isDev } from './env'

// electron-updater 是 CJS，autoUpdater 为其命名（lazy getter）导出；ESM 下经 default 解构取用。
const { autoUpdater } = electronUpdater

/** 定时后台检查周期（对齐 ChatGPT 约 15 分钟） */
const CHECK_INTERVAL_MS = 15 * 60 * 1000
/** 启动后延迟首检，避开启动高峰 */
const INITIAL_CHECK_DELAY_MS = 10 * 1000

export interface UpdaterManagerDeps {
  /** 每次状态变化时回调（供上层 broadcast） */
  onState: (next: UpdateState) => void
  /**
   * 真退出标记开关。macOS 原生 quitAndInstall 会先关闭所有窗口、全部关闭后才 app.quit()；
   * 主窗口的 close→hide 拦截（菜单栏常驻）会卡死这一步——必须先放行窗口关闭，失败时回滚。
   */
  setQuitting: (quitting: boolean) => void
}

/** releaseNotes 可能是字符串或 ReleaseNoteInfo[]，只取纯文本，否则 null */
function releaseNotesToText(notes: UpdateInfo['releaseNotes']): string | null {
  return typeof notes === 'string' && notes.trim() !== '' ? notes : null
}

export class UpdaterManager {
  private state: UpdateState = { status: 'idle' }
  /** 最近一次已知的目标版本（download-progress 事件不带版本号，需缓存） */
  private targetVersion = ''
  private initialTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: UpdaterManagerDeps) {}

  getState(): UpdateState {
    return this.state
  }

  private setState(next: UpdateState): void {
    this.state = next
    this.deps.onState(next)
  }

  /**
   * 自动更新可用条件：非 dev、已打包、且构建包含 app-update.yml。
   * pack/--dir 构建不生成 app-update.yml（只有 zip 等可更新 target 才生成），
   * 此时应静默禁用而不是让 electron-updater 报 ENOENT。
   */
  private isSupported(): boolean {
    if (isDev || !app.isPackaged) return false
    const resources = process.resourcesPath
    return typeof resources === 'string' && fs.existsSync(path.join(resources, 'app-update.yml'))
  }

  /** 注册更新事件 + 启动后首检 + 定时轮询 */
  init(): void {
    if (!this.isSupported()) {
      log.info('[updater] 跳过：dev / 未打包 / 构建缺 app-update.yml（pack 或 --dir 构建），自动更新不可用')
      return
    }

    autoUpdater.logger = log
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => this.setState({ status: 'checking' }))
    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.targetVersion = info.version
      this.setState({ status: 'available', version: info.version, notes: releaseNotesToText(info.releaseNotes) })
    })
    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.setState({ status: 'not-available', currentVersion: info.version })
    })
    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.setState({
        status: 'downloading',
        version: this.targetVersion,
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        transferred: progress.transferred,
        total: progress.total,
      })
    })
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      this.targetVersion = info.version
      this.setState({ status: 'ready', version: info.version })
    })
    autoUpdater.on('error', (err: Error) => {
      this.setState({ status: 'error', message: errorMessage(err) })
    })

    this.initialTimer = setTimeout(() => {
      void autoUpdater.checkForUpdates().catch((err: unknown) => log.error('[updater] 首检失败', err))
    }, INITIAL_CHECK_DELAY_MS)

    this.pollTimer = setInterval(() => {
      void autoUpdater.checkForUpdates().catch((err: unknown) => log.error('[updater] 定时检查失败', err))
    }, CHECK_INTERVAL_MS)
  }

  /** 手动触发检查（供 IPC 调用） */
  async check(): Promise<ActionResult> {
    if (!this.isSupported())
      return { ok: false, message: '此构建不支持自动更新（开发模式，或 pack/--dir 构建缺 app-update.yml）' }
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  /** 立即重启并安装已下载的更新 */
  quitAndInstall(): ActionResult {
    if (this.state.status !== 'ready') return { ok: false, message: '暂无已下载的更新' }
    try {
      // 先标记真退出，放行窗口关闭（见 UpdaterManagerDeps.setQuitting 注释）
      this.deps.setQuitting(true)
      // isSilent=false 显示安装进度；isForceRunAfter=true 安装后自动重启
      autoUpdater.quitAndInstall(false, true)
      return { ok: true }
    } catch (error) {
      // 没走成退出流程就回滚标记，避免之后正常关窗变成退出
      this.deps.setQuitting(false)
      return { ok: false, message: errorMessage(error) }
    }
  }

  dispose(): void {
    if (this.initialTimer !== null) clearTimeout(this.initialTimer)
    if (this.pollTimer !== null) clearInterval(this.pollTimer)
    this.initialTimer = null
    this.pollTimer = null
  }
}
