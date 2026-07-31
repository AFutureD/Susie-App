import process from 'node:process'
import { app, dialog, shell } from 'electron'
import { errorMessage } from '../../../shared/errors'
import { appFlags } from '../../env'
import type { IpcHandlers } from '../router'

export interface AppHandlerDeps {
  getMcpUrl: () => string | null
}

export function appHandlers(deps: AppHandlerDeps): IpcHandlers['app'] {
  return {
    getInfo: () => ({
      name: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      platform: process.platform,
      headless: appFlags.headless,
      loginItemEnabled: app.getLoginItemSettings().openAtLogin,
      mcpUrl: deps.getMcpUrl(),
    }),

    setLoginItem: ({ enabled }) => {
      try {
        app.setLoginItemSettings({ openAtLogin: enabled, args: ['--headless'] })
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },

    openExternal: async (payload) => {
      let url: URL
      try {
        url = new URL(payload.url)
      } catch {
        return { ok: false, message: `非法 URL：${payload.url}` }
      }
      // tg:：Telegram 官方 deeplink（managed bot 创建等场景直接唤起客户端，比 t.me 少一跳浏览器）
      if (url.protocol !== 'https:' && url.protocol !== 'tg:') {
        return { ok: false, message: `不允许的协议：${url.protocol}` }
      }
      try {
        await shell.openExternal(url.toString())
        return { ok: true }
      } catch (error) {
        return { ok: false, message: errorMessage(error) }
      }
    },

    pickDirectory: async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
  }
}
