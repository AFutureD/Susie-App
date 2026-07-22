import * as chrono from 'chrono-node'

export interface DateRange {
  start: number | null
  end: number | null
}

function startOfDay(date: Date): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function endOfDay(date: Date): number {
  return startOfDay(date) + 24 * 60 * 60 * 1000 - 1000
}

/** 支持 "-2d" 简写（对位 Python dateparser 的相对日期） */
function parseOne(text: string, now: Date): Date | null {
  const relative = /^-(\d+)d$/.exec(text.trim())
  if (relative?.[1] !== undefined) {
    return new Date(now.getTime() - Number(relative[1]) * 24 * 60 * 60 * 1000)
  }
  return chrono.parseDate(text, now)
}

/**
 * 自然语言日期范围（对位 Python mcp._date_range）。
 * dateRange 优先；单点结果按整天扩展。
 */
export function resolveDateRange(
  options: { dateStart?: string | null; dateEnd?: string | null; dateRange?: string | null },
  now: Date = new Date(),
): DateRange {
  const { dateStart, dateEnd, dateRange } = options

  if (dateRange !== undefined && dateRange !== null && dateRange.trim() !== '') {
    const results = chrono.parse(dateRange, now)
    const first = results[0]
    if (first !== undefined) {
      const start = first.start.date()
      const end = first.end?.date() ?? null
      if (end !== null) return { start: startOfDay(start), end: endOfDay(end) }
      return { start: startOfDay(start), end: endOfDay(start) }
    }
    return { start: null, end: null }
  }

  const start = dateStart !== undefined && dateStart !== null && dateStart !== '' ? parseOne(dateStart, now) : null
  const end = dateEnd !== undefined && dateEnd !== null && dateEnd !== '' ? parseOne(dateEnd, now) : null

  return {
    start: start === null ? null : startOfDay(start),
    end: end === null ? null : startOfDay(end),
  }
}
