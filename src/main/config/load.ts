import { parse, stringify } from 'smol-toml'
import type { ZodError } from 'zod'
import { configSchema, type Config } from '../../shared/config'

export type ParseConfigResult = { ok: true; config: Config; migrations: string[] } | { ok: false; error: string }

/** 解析 + 剔除 legacy 内容 + 校验。永不抛异常。 */
export function parseConfigText(text: string): ParseConfigResult {
  let data: unknown
  try {
    data = parse(text)
  } catch (error) {
    return { ok: false, error: `TOML 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }

  const { data: cleaned, migrations } = stripLegacy(data)

  const parsed = configSchema.safeParse(cleaned)
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) }
  }

  return { ok: true, config: parsed.data, migrations }
}

/**
 * 旧版（Python）配置的 legacy 内容只在内存中忽略并记录说明，
 * 不主动重写用户文件；只有用户在 UI 里保存时才会落为新格式。
 */
function stripLegacy(data: unknown): { data: unknown; migrations: string[] } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { data, migrations: [] }
  }

  const record: Record<string, unknown> = { ...(data as Record<string, unknown>) }
  const migrations: string[] = []

  for (const key of ['api_id', 'api_hash']) {
    if (key in record) {
      delete record[key]
      migrations.push(`已忽略 legacy 字段 "${key}"（桌面版不再支持 Telegram 用户账号通道）`)
    }
  }

  const channels = record['channels']
  if (channels !== null && typeof channels === 'object' && !Array.isArray(channels)) {
    const kept: Record<string, unknown> = {}
    for (const [id, channel] of Object.entries(channels)) {
      const type =
        channel !== null && typeof channel === 'object' ? (channel as Record<string, unknown>)['type'] : undefined
      if (type === 'telegram_user') {
        migrations.push(`已忽略通道 "channels.${id}"（类型 telegram_user 不再支持）`)
        continue
      }
      kept[id] = channel
    }
    record['channels'] = kept
  }

  return { data: record, migrations }
}

export function formatZodError(error: ZodError): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${where}: ${issue.message}`
  })
  return `配置校验失败：${lines.join('；')}`
}

/** 序列化为 canonical TOML（键序固定：channels → assistants → bindings） */
export function serializeConfig(config: Config): string {
  // JSON 往返去掉 undefined 值（TOML 无 null/undefined）
  const clean = JSON.parse(
    JSON.stringify({ channels: config.channels, assistants: config.assistants, bindings: config.bindings }),
  ) as Record<string, unknown>
  return `${stringify(clean)}\n`
}

export function defaultConfig(): Config {
  return configSchema.parse({})
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, sortKeys(v)] as const)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries)
  }
  return value
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b)
}
