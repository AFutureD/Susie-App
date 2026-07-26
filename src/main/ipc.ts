import fs from 'node:fs'
import { BrowserWindow, ipcMain } from 'electron'
import log from 'electron-log/main'
import type { IpcEventSchema, IpcInvokeSchema } from '../shared/ipc'
import { fetchBotUsername } from './channels/telegram-bot'
import { errorLog } from './logging'
import type { SusieService } from './service'
import { checkForUpdates, getUpdateState, quitAndInstall } from './updater'

type InvokeHandler<K extends keyof IpcInvokeSchema> = (
  payload: IpcInvokeSchema[K]['req'],
) => IpcInvokeSchema[K]['res'] | Promise<IpcInvokeSchema[K]['res']>

function handle<K extends keyof IpcInvokeSchema>(channel: K, handler: InvokeHandler<K>): void {
  ipcMain.handle(channel, (_event, payload) => handler(payload as IpcInvokeSchema[K]['req']))
}

/** 向所有窗口推送事件 */
export function broadcast<K extends keyof IpcEventSchema>(channel: K, payload: IpcEventSchema[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerIpcHandlers(service: SusieService): void {
  // app / config / assistants 域已迁移到契约路由（main/ipc/handlers/）

  handle('channels:resolve-username', async (payload) => {
    try {
      return { ok: true as const, username: await fetchBotUsername(payload.token) }
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
    }
  })

  // ---------- 服务 ----------

  handle('channel:statuses', () => service.hub.statuses())

  handle('history:chats', () => service.history.listChats())
  handle('history:senders', (payload) =>
    service.history.listSenders(payload.channelId, payload.chatId, { privateOnly: payload.privateOnly ?? false }),
  )
  handle('history:messages', (payload) =>
    service.history.listMessages(payload.channelId, payload.chatId, {
      limit: payload.limit ?? 80,
      ...(payload.beforeId === undefined ? {} : { beforeId: payload.beforeId }),
    }),
  )
  handle('history:search', (payload) => service.history.search(payload.q, payload.limit ?? 50))

  handle('chat:send', async (payload) => {
    try {
      await service.chatManager.sendMessage({
        channelId: payload.channelId,
        chatId: payload.chatId,
        parts: [{ kind: 'text', text: payload.text }],
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('agents:overview', () => service.agentsOverview())
  handle('agents:models', (payload) => service.listAgentModels(payload.agentId))
  handle('agents:install', async (payload) => {
    try {
      await service.installAgent(payload.id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })
  handle('agents:uninstall', (payload) => {
    try {
      service.uninstallAgent(payload.id)
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('logs:tail', (payload) => {
    const logger = payload.file === 'error' ? errorLog : log
    const file = logger.transports.file.getFile().path
    try {
      const text = fs.readFileSync(file, 'utf-8')
      const lines = text.split('\n')
      const count = Math.min(Math.max(payload.lines ?? 300, 10), 2000)
      return { path: file, lines: lines.slice(-count) }
    } catch {
      return { path: file, lines: [] }
    }
  })

  handle('autoreview:list', (payload) => service.history.listAutoReviews(payload.limit))

  // ---------- 自动更新 ----------

  handle('update:check', () => checkForUpdates())
  handle('update:install', () => quitAndInstall())
  handle('update:get-state', () => getUpdateState())
}
