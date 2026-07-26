import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '../shared/messages'
import { UpdaterManager } from './updater-manager'

// electron / electron-updater 在 vitest node 环境不可用，全部 mock；
// autoUpdaterMock 手写最小事件表（Map 单监听即可，updater 每个事件只注册一次）。
const { autoUpdaterMock, envMock, electronMock, fsMock } = vi.hoisted(() => {
  const listeners = new Map<string, (arg: never) => void>()
  const updaterMock = {
    listeners,
    logger: null as unknown,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
    on(event: string, listener: (arg: never) => void) {
      listeners.set(event, listener)
      return updaterMock
    },
    emit(event: string, arg?: unknown) {
      listeners.get(event)?.(arg as never)
    },
  }
  return {
    autoUpdaterMock: updaterMock,
    envMock: { isDev: false, appFlags: { headless: false, smoke: false }, devServerUrl: undefined },
    electronMock: { app: { isPackaged: true } },
    fsMock: { existsSync: vi.fn(() => true) },
  }
})

vi.mock('electron', () => electronMock)
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), error: vi.fn() } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: autoUpdaterMock } }))
vi.mock('./env', () => envMock)
vi.mock('node:fs', () => ({ default: fsMock }))

/** 类实例天然隔离状态：每个用例 new 一个（不再需要 resetModules 舞步） */
function makeUpdater() {
  const states: UpdateState[] = []
  let quitting = false
  const updater = new UpdaterManager({
    onState: (next) => states.push(next),
    setQuitting: (value) => {
      quitting = value
    },
  })
  return { updater, states, isQuitting: () => quitting }
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

describe('UpdaterManager 状态机', () => {
  it('事件归一化为 UpdateState：checking → available → downloading → ready', () => {
    const { updater, states } = makeUpdater()
    updater.init()

    autoUpdaterMock.emit('checking-for-update')
    expect(updater.getState()).toEqual({ status: 'checking' })

    autoUpdaterMock.emit('update-available', { version: '0.2.0', releaseNotes: '修复若干问题' })
    expect(updater.getState()).toEqual({ status: 'available', version: '0.2.0', notes: '修复若干问题' })

    // download-progress 事件本身不带版本号，应取 update-available 缓存的目标版本
    autoUpdaterMock.emit('download-progress', { percent: 42.5, bytesPerSecond: 1024, transferred: 425, total: 1000 })
    expect(updater.getState()).toEqual({
      status: 'downloading',
      version: '0.2.0',
      percent: 42.5,
      bytesPerSecond: 1024,
      transferred: 425,
      total: 1000,
    })

    autoUpdaterMock.emit('update-downloaded', { version: '0.2.0' })
    expect(updater.getState()).toEqual({ status: 'ready', version: '0.2.0' })

    expect(states.map((next) => next.status)).toEqual(['checking', 'available', 'downloading', 'ready'])
    updater.dispose()
  })

  it('结构化 releaseNotes（非字符串）归一化为 null', () => {
    const { updater } = makeUpdater()
    updater.init()
    autoUpdaterMock.emit('update-available', { version: '0.2.0', releaseNotes: [{ version: '0.2.0', note: 'x' }] })
    expect(updater.getState()).toEqual({ status: 'available', version: '0.2.0', notes: null })
    updater.dispose()
  })

  it('update-not-available 与 error 映射', () => {
    const { updater } = makeUpdater()
    updater.init()

    autoUpdaterMock.emit('update-not-available', { version: '0.1.0' })
    expect(updater.getState()).toEqual({ status: 'not-available', currentVersion: '0.1.0' })

    autoUpdaterMock.emit('error', new Error('网络不可达'))
    expect(updater.getState()).toEqual({ status: 'error', message: '网络不可达' })
    updater.dispose()
  })

  it('quitAndInstall 仅在 ready 状态可用，且放行窗口关闭（setQuitting）', () => {
    const { updater, isQuitting } = makeUpdater()
    updater.init()

    expect(updater.quitAndInstall()).toEqual({ ok: false, message: '暂无已下载的更新' })
    expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
    expect(isQuitting()).toBe(false)

    autoUpdaterMock.emit('update-downloaded', { version: '0.2.0' })
    expect(updater.quitAndInstall()).toEqual({ ok: true })
    expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledWith(false, true)
    // macOS 原生 quitAndInstall 先关窗后 quit；close→hide 拦截必须被放行，否则 app 不退出、ShipIt 干等
    expect(isQuitting()).toBe(true)
    updater.dispose()
  })

  it('quitAndInstall 失败时回滚 quitting 标记', () => {
    const { updater, isQuitting } = makeUpdater()
    updater.init()
    autoUpdaterMock.emit('update-downloaded', { version: '0.2.0' })

    autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(updater.quitAndInstall()).toEqual({ ok: false, message: 'boom' })
    expect(isQuitting()).toBe(false)
    updater.dispose()
  })

  it('启动 10 秒后首检，随后每 15 分钟轮询；dispose 停止轮询', async () => {
    const { updater } = makeUpdater()
    updater.init()

    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(15 * 60_000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)

    updater.dispose()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
  })

  it('dev / 未打包时 no-op：不注册事件，手动检查返回不支持', async () => {
    envMock.isDev = true
    const { updater } = makeUpdater()
    updater.init()

    expect(autoUpdaterMock.listeners.size).toBe(0)
    expect(await updater.check()).toEqual({
      ok: false,
      message: '此构建不支持自动更新（开发模式，或 pack/--dir 构建缺 app-update.yml）',
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('构建缺 app-update.yml（pack/--dir）时 no-op，不让 electron-updater 报 ENOENT', async () => {
    fsMock.existsSync.mockReturnValue(false)
    const { updater } = makeUpdater()
    updater.init()

    expect(autoUpdaterMock.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect((await updater.check()).ok).toBe(false)
  })
})
