// 标准 5 字段 cron（分 时 日 月 周）的最小实现：解析、分钟粒度匹配、下次触发时间。
// main 的调度器与 renderer 的「下次执行」预览同源。本地时区。
//
// 每字段支持 `*`、`*/step`、数字、区间 `a-b` 及数字/区间的逗号列表；不支持的写法
// （秒字段、名称别名、`a-b/step` 等）解析失败，由 schema 校验拦下并提示。
// 周字段 0=周日 … 6=周六；日与周同时受限时按 vixie cron 取并集（OR）。

export interface CronSpec {
  /** null = 该字段为 `*`（不受限） */
  minute: ReadonlySet<number> | null
  hour: ReadonlySet<number> | null
  dayOfMonth: ReadonlySet<number> | null
  month: ReadonlySet<number> | null
  dayOfWeek: ReadonlySet<number> | null
}

const FIELD_RANGES = [
  { min: 0, max: 59 }, // 分
  { min: 0, max: 23 }, // 时
  { min: 1, max: 31 }, // 日
  { min: 1, max: 12 }, // 月
  { min: 0, max: 6 }, // 周（0=周日）
] as const

export function parseCron(expr: string): CronSpec | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const parsed: (ReadonlySet<number> | null)[] = []
  for (let index = 0; index < 5; index += 1) {
    const range = FIELD_RANGES[index]!
    const field = parseField(fields[index]!, range.min, range.max)
    if (field === undefined) return null
    parsed.push(field)
  }
  return { minute: parsed[0]!, hour: parsed[1]!, dayOfMonth: parsed[2]!, month: parsed[3]!, dayOfWeek: parsed[4]! }
}

/** undefined = 语法/取值错误；null = `*` */
function parseField(text: string, min: number, max: number): ReadonlySet<number> | null | undefined {
  if (text === '*') return null

  const step = /^\*\/(\d+)$/.exec(text)
  if (step !== null) {
    const by = Number(step[1])
    if (by < 1 || by > max) return undefined
    const values = new Set<number>()
    for (let value = min; value <= max; value += 1) {
      if ((value - min) % by === 0) values.add(value)
    }
    return values
  }

  const values = new Set<number>()
  for (const item of text.split(',')) {
    const range = /^(\d+)-(\d+)$/.exec(item)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from < min || to > max || from > to) return undefined
      for (let value = from; value <= to; value += 1) values.add(value)
      continue
    }
    if (!/^\d+$/.test(item)) return undefined
    const value = Number(item)
    if (value < min || value > max) return undefined
    values.add(value)
  }
  return values
}

export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (spec.minute !== null && !spec.minute.has(date.getMinutes())) return false
  if (spec.hour !== null && !spec.hour.has(date.getHours())) return false
  if (spec.month !== null && !spec.month.has(date.getMonth() + 1)) return false
  const domOk = spec.dayOfMonth === null || spec.dayOfMonth.has(date.getDate())
  const dowOk = spec.dayOfWeek === null || spec.dayOfWeek.has(date.getDay())
  if (spec.dayOfMonth !== null && spec.dayOfWeek !== null) return domOk || dowOk
  return domOk && dowOk
}

/**
 * 严格晚于 from 的下一次触发（epoch ms）；366 天内无解返回 null（如 `0 0 30 2 *`）。
 * 逐分钟推进：epoch 步进 + 读本地时间字段，DST 跳变自然正确（被跳过的本地时间不会出现）。
 */
export function nextRunAt(spec: CronSpec, fromMs: number): number | null {
  const start = Math.floor(fromMs / 60_000) * 60_000 + 60_000
  const limit = start + 366 * 24 * 60 * 60_000
  for (let ts = start; ts < limit; ts += 60_000) {
    if (cronMatches(spec, new Date(ts))) return ts
  }
  return null
}
