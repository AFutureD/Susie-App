import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../shared/messages'

// electron / electron-updater 在 vitest node 环境不可用，全部 mock；
// autoUpdaterMock 手写最小事件表（Map 单监听即可，updater 每个事件只注册一次）。
const { autoUpdaterMock, envMock, electronMock, fsMock } = vi.hoisted(() => {
  const listeners = new Map<string, (arg: never) => void>()
  const autoUpdaterMock = {
    listeners,
    logger: null as unknown,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
    on(event: string, listener: (arg: never) => void) {
      listeners.set(event, listener)
      return autoUpdaterMock
    },
    emit(event: string, arg?: unknown) {
      listeners.get(event)?.(arg as never)
    },
  }
  const envMock = { isDev: false, appFlags: { headless: false, smoke: false }, devServerUrl: undefined }
  const electronMock = { app: { isPackaged: true } }
  const fsMock = { existsSync: vi.fn(() => true) }
  return { autoUpdaterMock, envMock, electronMock, fsMock }
})

vi.mock('electron', () => electronMock)
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), error: vi.fn() } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: autoUpdaterMock } }))
vi.mock('./env', () => envMock)
vi.mock('node:fs', () => ({ default: fsMock }))

/**
 * 模块内有状态（state/targetVersion），每个用例重新加载取干净实例；
 * lifecycle 必须与 updater 同一模块图（resetModules 后重新 import），否则断言不到同一实例
 */
async function loadUpdater() {
  vi.resetModules()
  const [updater, { lifecycle }] = await Promise.all([import('./updater'), import('./lifecycle')])
  return { ...updater, lifecycle }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  autoUpdaterMock.listeners.clear()
  envMock.isDev = false
  electronMock.app.isPackaged = true
  fsMock.existsSync.mockReturnValue(true)
  // Electron 注入的资源路径，node 测试环境下手工指定
  ;(process as { resourcesPath?: string }).resourcesPath = '/fake/Resources'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('updater 状态机', () => {
  it('事件归一化为 UpdateState：checking → available → downloading → ready', async () => {
    const updater = await loadUpdater()
    const states: UpdateState[] = []
    updater.initUpdater((next) => states.push(next))

    autoUpdaterMock.emit('checking-for-update')
    expect(updater.getUpdateState()).toEqual({ status: 'checking' })

    autoUpdaterMock.emit('update-available', { version: '0.2.0', releaseNotes: '修复若干问题' })
    expect(updater.getUpdateState()).toEqual({ status: 'available', version: '0.2.0', notes: '修复若干问题' })

    // download-progress 事件本身不带版本号，应取 update-available 缓存的目标版本
    autoUpdaterMock.emit('download-progress', { percent: 42.5, bytesPerSecond: 1024, transferred: 425, total: 1000 })
    expect(updater.getUpdateState()).toEqual({
      status: 'downloading',
      version: '0.2.0',
      percent: 42.5,
      bytesPerSecond: 1024,
      transferred: 425,
      total: 1000,
    })

    autoUpdaterMock.emit('update-downloaded', { version: '0.2.0' })
    expect(updater.getUpdateState()).toEqual({ status: 'ready', version: '0.2.0' })

    expect(states.map((next) => next.status)).toEqual(['checking', 'available', 'downloading', 'ready'])
  })

  it('结构化 releaseNotes（非字符串）归一化为 null', async () => {
    const updater = await loadUpdater()
    updater.initUpdater(() => {})
    autoUpdaterMock.emit('update-available', { version: '0.2.0', releaseNotes: [{ version: '0.2.0', note: 'x' }] })
    expect(updater.getUpdateState()).toEqual({ status: 'available', version: '0.2.0', notes: null })
  })

  it('update-not-available 与 error 映射', async () => {
    const updater = await loadUpdater()
    updater.initUpdater(() => {})

    autoUpdaterMock.emit('update-not-available', { version: '0.1.0' })
    expect(updater.getUpdateState()).toEqual({ status: 'not-available', currentVersion: '0.1.0' })

    autoUpdaterMock.emit('error', new Error('网络不可达'))
    expect(updater.getUpdateState()).toEqual({ status: 'error', message: '网络不可达' })
  })

  it('quitAndInstall 仅在 ready 状态可用，且放行窗口关闭（lifecycle.quitting）', async () => {
    const updater = await loadUpdater()
    updater.initUpdater(() => {})

    expect(updater.quitAndInstall()).toEqual({ ok: false, message: '暂无已下载的更新' })
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(updater.lifecycle.quitting).toBe(false)

    autoUpdaterMock.emit('update-downloaded', { version: '0.2.0' })
    expect(updater.quitAndInstall()).toEqual({ ok: true })
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true)
    // macOS 原生 quitAndInstall 先关窗后 quit；close→hide 拦截必须被放行，否则 app 不退出、ShipIt 干等
    expect(updater.lifecycle.quitting).toBe(true)
  })

  it('quitAndInstall 失败时回滚 quitting 标记', async () => {
    const updater = await loadUpdater()
    updater.initUpdater(() => {})
    autoUpdaterMock.emit('update-downloaded', { version: '0.2.0' })

    autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(updater.quitAndInstall()).toEqual({ ok: false, message: 'boom' })
    expect(updater.lifecycle.quitting).toBe(false)
  })

  it('启动 10 秒后首检，随后每 15 分钟轮询', async () => {
    const updater = await loadUpdater()
    updater.initUpdater(() => {})

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('dev / 未打包时 no-op：不注册事件，手动检查返回不支持', async () => {
    envMock.isDev = true
    const updater = await loadUpdater()
    updater.initUpdater(() => {})

    expect(autoUpdaterMock.listeners.size).toBe(0)
    expect(await updater.checkForUpdates()).toEqual({
      ok: false,
      message: '此构建不支持自动更新（开发模式，或 pack/--dir 构建缺 app-update.yml）',
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('构建缺 app-update.yml（pack/--dir）时 no-op，不让 electron-updater 报 ENOENT', async () => {
    fsMock.existsSync.mockReturnValue(false)
    const updater = await loadUpdater()
    updater.initUpdater(() => {})

    expect(autoUpdaterMock.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect((await updater.checkForUpdates()).ok).toBe(false)
  })
})
