import { parse, stringify } from 'smol-toml'
import type { ZodError } from 'zod'
import { DEFAULT_ASSISTANT_ID, assistantSchema, configSchema, type Config } from '../../shared/config'

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

/** 序列化为 canonical TOML（键序固定：channels → manager_bots → assistants → bindings → users → auto_review → scheduled_tasks） */
export function serializeConfig(config: Config): string {
  // JSON 往返去掉 undefined 值（TOML 无 null/undefined）
  const clean = JSON.parse(
    JSON.stringify({
      channels: config.channels,
      manager_bots: config.manager_bots,
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

/**
 * default 助手保障：id='default' 的助手是不可删除的兜底（onboarding 绑定步、
 * 渠道弹窗回落都指向它）。配置合法但缺失时补建最小配置（agent_id 走 schema 默认），
 * prepend 使形态与默认配置一致；调用方负责把 changed 的结果落盘。
 */
export function ensureDefaultAssistant(config: Config): { config: Config; changed: boolean } {
  if (config.assistants.some((assistant) => assistant.id === DEFAULT_ASSISTANT_ID)) {
    return { config, changed: false }
  }
  return {
    config: { ...config, assistants: [assistantSchema.parse({ id: DEFAULT_ASSISTANT_ID }), ...config.assistants] },
    changed: true,
  }
}

// stableStringify / deepEqual 已上移 shared/equal.ts（renderer 的 configAtom 选择器复用）
export { deepEqual, stableStringify } from '../../shared/equal'
