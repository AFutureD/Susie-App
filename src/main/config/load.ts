import { parse, stringify } from 'smol-toml'
import type { ZodError } from 'zod'
import { configSchema, type Config } from '../../shared/config'

export type ParseConfigResult = { ok: true; config: Config } | { ok: false; error: string }

/** 解析 + 校验（无兼容迁移：未知/已废弃字段直接校验失败）。永不抛异常。 */
export function parseConfigText(text: string): ParseConfigResult {
  let data: unknown
  try {
    data = parse(text)
  } catch (error) {
    return { ok: false, error: `TOML 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }

  const parsed = configSchema.safeParse(data)
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) }
  }

  return { ok: true, config: parsed.data }
}

export function formatZodError(error: ZodError): string {
  const lines = error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${where}: ${issue.message}`
  })
  return `配置校验失败：${lines.join('；')}`
}

/** 序列化为 canonical TOML（键序固定：channels → assistants → bindings → users → auto_review → scheduled_tasks） */
export function serializeConfig(config: Config): string {
  // JSON 往返去掉 undefined 值（TOML 无 null/undefined）
  const clean = JSON.parse(
    JSON.stringify({
      channels: config.channels,
      assistants: config.assistants,
      bindings: config.bindings,
      users: config.users,
      auto_review: config.auto_review,
      scheduled_tasks: config.scheduled_tasks,
    }),
  ) as Record<string, unknown>
  return `${stringify(clean)}\n`
}

export function defaultConfig(): Config {
  return configSchema.parse({})
}

// stableStringify / deepEqual 已上移 shared/equal.ts（renderer 的 configAtom 选择器复用）
export { deepEqual, stableStringify } from '../../shared/equal'
