import process from 'node:process'

export const devServerUrl = process.env['VITE_DEV_SERVER_URL']
export const isDev = devServerUrl !== undefined

export const appFlags = {
  /** 不创建主窗口，仅菜单栏常驻（供登录项自启） */
  headless: process.argv.includes('--headless'),
  /** 冒烟模式：启动完成后自动退出，用于 CI/脚本验证 */
  smoke: process.env['SUSIE_SMOKE'] === '1',
}
