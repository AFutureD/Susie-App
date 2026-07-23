import fs from 'node:fs'
import process from 'node:process'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import log from 'electron-log/main'
import { z } from 'zod'
import { assistantSchema, bindingSchema, channelSettingsSchema, type ConfigMutationResult } from '../shared/config'
import type { IpcEventSchema, IpcInvokeSchema } from '../shared/ipc'
import { getWorkspaceDir } from './config/paths'
import { fetchBotUsername } from './channels/telegram-bot'
import type { ConfigStore } from './config/store'
import { appFlags } from './env'
import { errorLog } from './logging'
import type { SusieService } from './service'

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

export function registerIpcHandlers(config: ConfigStore, service: SusieService): void {
  handle('app:get-info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node,
    platform: process.platform,
    headless: appFlags.headless,
    loginItemEnabled: app.getLoginItemSettings().openAtLogin,
    mcpUrl: service.mcp.url,
  }))

  handle('app:set-login-item', (payload) => {
    try {
      app.setLoginItemSettings({ openAtLogin: payload.enabled, args: ['--headless'] })
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('app:open-external', async (payload) => {
    let url: URL
    try {
      url = new URL(payload.url)
    } catch {
      return { ok: false, message: `非法 URL：${payload.url}` }
    }
    if (url.protocol !== 'https:') return { ok: false, message: `不允许的协议：${url.protocol}` }
    try {
      await shell.openExternal(url.toString())
      return { ok: true }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('dialog:pick-directory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  // ---------- 配置 ----------

  handle('config:get', () => config.state())
  handle('config:get-raw', () => ({ text: config.readRawText(), version: config.currentVersion }))
  handle('config:save-raw', (payload) => config.saveRaw(payload.text, payload.expectedVersion))

  handle('config:upsert-channel', (payload) => {
    const settings = channelSettingsSchema.safeParse(payload.settings)
    if (!settings.success) return invalid(settings.error.issues[0]?.message)
    return config.upsertChannel(payload.id, settings.data, payload.expectedVersion)
  })
  handle('config:delete-channel', (payload) => config.deleteChannel(payload.id, payload.expectedVersion))

  handle('config:upsert-assistant', (payload) => {
    const assistant = assistantSchema.safeParse(payload.assistant)
    if (!assistant.success) return invalid(assistant.error.issues[0]?.message)
    return config.upsertAssistant(assistant.data, payload.expectedVersion)
  })
  handle('config:delete-assistant', (payload) => config.deleteAssistant(payload.id, payload.expectedVersion))

  handle('channels:resolve-username', async (payload) => {
    try {
      return { ok: true as const, username: await fetchBotUsername(payload.token) }
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) }
    }
  })

  handle('config:set-bindings', (payload) => {
    const bindings = z.array(bindingSchema).safeParse(payload.bindings)
    if (!bindings.success) return invalid(bindings.error.issues[0]?.message)
    return config.setBindings(bindings.data, payload.expectedVersion)
  })

  handle('assistants:open-workdir', async (payload) => {
    const assistant = config.state().config.assistants.find((item) => item.id === payload.id)
    if (assistant === undefined) return { ok: false, message: `assistant 不存在：${payload.id}` }
    const dir = assistant.work_dir ?? getWorkspaceDir(assistant.id)
    try {
      fs.mkdirSync(dir, { recursive: true })
      const failure = await shell.openPath(dir)
      return failure === '' ? { ok: true } : { ok: false, message: failure }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  })

  // ---------- 服务 ----------

  handle('channel:statuses', () => service.hub.statuses())

  handle('history:chats', () => service.history.listChats())
  handle('history:senders', (payload) => service.history.listSenders(payload.channelId, payload.chatId))
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
}

function invalid(message: string | undefined): ConfigMutationResult {
  return { ok: false, conflict: false, message: message ?? '入参不合法' }
}
