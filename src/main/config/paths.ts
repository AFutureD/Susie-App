import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

// 与 Python 版保持一致：~/.config/susie/config.toml。
// SUSIE_CONFIG_DIR 用于测试 / 冒烟隔离。

export function getConfigDir(): string {
  const override = process.env['SUSIE_CONFIG_DIR']
  if (override && override !== '') return override

  const xdg = process.env['XDG_CONFIG_HOME']
  const base = xdg && xdg !== '' ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, 'susie')
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), 'config.toml')
}

export function getWorkspaceDir(assistantId: string): string {
  return path.join(getConfigDir(), 'workspace', assistantId)
}
