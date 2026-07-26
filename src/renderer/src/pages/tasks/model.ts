import type { IntlShape } from 'react-intl'

// 任务页纯逻辑：调度预设 ⇄ cron 互转与描述文案。
// cron 只存在于存储层；UI 呈现/编辑的是预设，认不出的手写表达式按「自定义」原样保留。

export type SchedulePreset =
  | { kind: 'every_minutes'; minutes: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; weekdays: number[]; time: string }
  | { kind: 'monthly'; days: number[]; time: string }

export type PresetKind = SchedulePreset['kind']

/** 新任务的默认调度：每天 09:00 */
export const DEFAULT_CRON = '0 9 * * *'

export function newTaskId(): string {
  return `task-${Date.now().toString(36)}`
}

const pad = (value: number): string => String(value).padStart(2, '0')

function timeParts(time: string): { hour: number; minute: number } {
  const [hour, minute] = time.split(':')
  return { hour: Number(hour), minute: Number(minute) }
}

export function toCron(preset: SchedulePreset): string {
  switch (preset.kind) {
    case 'every_minutes':
      return `*/${preset.minutes} * * * *`
    case 'hourly':
      return `${preset.minute} * * * *`
    case 'daily': {
      const { hour, minute } = timeParts(preset.time)
      return `${minute} ${hour} * * *`
    }
    case 'weekly': {
      const { hour, minute } = timeParts(preset.time)
      return `${minute} ${hour} * * ${sorted(preset.weekdays).join(',')}`
    }
    case 'monthly': {
      const { hour, minute } = timeParts(preset.time)
      return `${minute} ${hour} ${sorted(preset.days).join(',')} * *`
    }
  }
}

/** 反解析：认不出（手写的复杂表达式）返回 null */
export function fromCron(expr: string): SchedulePreset | null {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string]
  if (month !== '*') return null

  const step = /^\*\/(\d+)$/.exec(minute)
  if (step !== null) {
    if (hour !== '*' || dom !== '*' || dow !== '*') return null
    const minutes = Number(step[1])
    return minutes >= 1 && minutes <= 59 ? { kind: 'every_minutes', minutes } : null
  }

  const minuteNum = parseNum(minute, 0, 59)
  if (minuteNum === null) return null
  if (hour === '*') {
    return dom === '*' && dow === '*' ? { kind: 'hourly', minute: minuteNum } : null
  }

  const hourNum = parseNum(hour, 0, 23)
  if (hourNum === null) return null
  const time = `${pad(hourNum)}:${pad(minuteNum)}`
  if (dom === '*' && dow === '*') return { kind: 'daily', time }
  if (dom === '*') {
    const weekdays = parseList(dow, 0, 6)
    return weekdays === null ? null : { kind: 'weekly', weekdays, time }
  }
  if (dow === '*') {
    const days = parseList(dom, 1, 31)
    return days === null ? null : { kind: 'monthly', days, time }
  }
  return null
}

/** 调度的人类可读描述（列表与预览共用） */
export function describeSchedule(intl: IntlShape, cron: string): string {
  const preset = fromCron(cron)
  if (preset === null) return intl.formatMessage({ id: 'tasks.schedule.desc.custom' }, { expr: cron })
  switch (preset.kind) {
    case 'every_minutes':
      return intl.formatMessage({ id: 'tasks.schedule.desc.every_minutes' }, { minutes: preset.minutes })
    case 'hourly':
      return intl.formatMessage({ id: 'tasks.schedule.desc.hourly' }, { minute: preset.minute })
    case 'daily':
      return intl.formatMessage({ id: 'tasks.schedule.desc.daily' }, { time: preset.time })
    case 'weekly': {
      const days = sorted(preset.weekdays)
        .map((day) => intl.formatMessage({ id: `tasks.weekday.${day}` }))
        .join('、')
      return intl.formatMessage({ id: 'tasks.schedule.desc.weekly' }, { days, time: preset.time })
    }
    case 'monthly': {
      const days = sorted(preset.days).join('、')
      return intl.formatMessage({ id: 'tasks.schedule.desc.monthly' }, { days, time: preset.time })
    }
  }
}

function sorted(values: number[]): number[] {
  return [...new Set(values)].toSorted((a, b) => a - b)
}

function parseNum(text: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return value >= min && value <= max ? value : null
}

function parseList(text: string, min: number, max: number): number[] | null {
  const values: number[] = []
  for (const item of text.split(',')) {
    const value = parseNum(item, min, max)
    if (value === null) return null
    values.push(value)
  }
  return values.length > 0 ? sorted(values) : null
}
