import { useState, type ReactNode } from 'react'
import { useIntl } from 'react-intl'
import { nextRunAt, parseCron } from '../../../../shared/schedule'
import { Button, Field, Select, TextInput } from '../../components/form'
import { Modal } from '../../components/modal'
import { describeSchedule, fromCron, toCron, type PresetKind, type SchedulePreset } from './model'

// 调度编辑：行内只显示人类可读描述，「编辑」打开弹窗。
// 弹窗布局：重复方式 + 参数两列并排，星期/日期整行铺开，底部预览条实时显示
// 描述与下次执行时间；「确定」才写回、「取消」丢弃。值始终是 cron 字符串。

const KINDS: PresetKind[] = ['every_minutes', 'hourly', 'daily', 'weekly', 'monthly']

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export function ScheduleEditor({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const intl = useIntl()
  const [open, setOpen] = useState(false)

  return (
    <div className="flex items-center gap-3 rounded-md border border-line bg-surface py-1 pr-1 pl-2.5">
      <span className="flex-1 truncate text-sm">{describeSchedule(intl, value)}</span>
      <Button className="shrink-0" onClick={() => setOpen(true)}>
        {intl.formatMessage({ id: 'common.edit' })}
      </Button>
      {open && (
        <ScheduleModal
          initial={value}
          onConfirm={(cron) => {
            onChange(cron)
            setOpen(false)
          }}
          onCancel={() => setOpen(false)}
        />
      )}
    </div>
  )
}

function ScheduleModal({
  initial,
  onConfirm,
  onCancel,
}: {
  initial: string
  onConfirm: (cron: string) => void
  onCancel: () => void
}) {
  const intl = useIntl()
  const [cron, setCron] = useState(initial)
  const preset = fromCron(cron)
  const apply = (next: SchedulePreset): void => setCron(toCron(next))

  const switchKind = (kind: string): void => {
    const time = preset !== null && 'time' in preset ? preset.time : '09:00'
    const next: SchedulePreset =
      kind === 'every_minutes'
        ? { kind, minutes: 15 }
        : kind === 'hourly'
          ? { kind, minute: 0 }
          : kind === 'daily'
            ? { kind, time }
            : kind === 'weekly'
              ? { kind, weekdays: [1], time }
              : { kind: 'monthly', days: [1], time }
    setCron(toCron(next))
  }

  const spec = parseCron(cron)
  const nextTs = spec === null ? null : nextRunAt(spec, Date.now())

  return (
    <Modal
      title={intl.formatMessage({ id: 'tasks.schedule.modal.title' })}
      panelClassName="w-[26rem] overflow-y-auto p-5"
      onClose={onCancel}
    >
      <div className="mt-4 grid grid-cols-2 gap-4">
        <Field label={intl.formatMessage({ id: 'tasks.schedule.field.kind' })}>
          <Select value={preset?.kind ?? 'custom'} onChange={(event) => switchKind(event.target.value)}>
            {preset === null && (
              <option value="custom">{intl.formatMessage({ id: 'tasks.schedule.kind.custom' })}</option>
            )}
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {intl.formatMessage({ id: `tasks.schedule.kind.${kind}` })}
              </option>
            ))}
          </Select>
        </Field>
        {preset !== null && <ParamField preset={preset} onChange={apply} />}
      </div>

      {preset?.kind === 'weekly' && (
        <Group label={intl.formatMessage({ id: 'tasks.schedule.field.weekdays' })}>
          <div className="flex gap-1.5">
            {WEEKDAY_ORDER.map((day) => (
              <ToggleChip
                key={day}
                className="flex-1 py-1.5"
                label={intl.formatMessage({ id: `tasks.weekday.${day}` })}
                active={preset.weekdays.includes(day)}
                onToggle={() => {
                  const next = preset.weekdays.includes(day)
                    ? preset.weekdays.filter((item) => item !== day)
                    : [...preset.weekdays, day]
                  // 至少保留一天
                  if (next.length > 0) apply({ ...preset, weekdays: next })
                }}
              />
            ))}
          </div>
        </Group>
      )}

      {preset?.kind === 'monthly' && (
        <Group label={intl.formatMessage({ id: 'tasks.schedule.field.days' })}>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
              <ToggleChip
                key={day}
                className="py-1"
                label={String(day)}
                active={preset.days.includes(day)}
                onToggle={() => {
                  const next = preset.days.includes(day)
                    ? preset.days.filter((item) => item !== day)
                    : [...preset.days, day]
                  if (next.length > 0) apply({ ...preset, days: next })
                }}
              />
            ))}
          </div>
        </Group>
      )}

      {preset === null && (
        <p className="mt-3 text-xs leading-5 text-ink-muted">
          {intl.formatMessage({ id: 'tasks.schedule.custom.hint' })}
        </p>
      )}

      <div className="mt-4 rounded-lg border border-line bg-surface px-3.5 py-2.5">
        <p className="text-sm font-medium">{describeSchedule(intl, cron)}</p>
        {nextTs !== null && (
          <p className="mt-0.5 text-xs text-ink-muted">
            {intl.formatMessage({ id: 'tasks.schedule.next' }, { time: new Date(nextTs).toLocaleString() })}
          </p>
        )}
      </div>

      <div className="mt-5 flex gap-2">
        <Button variant="primary" onClick={() => onConfirm(cron)}>
          {intl.formatMessage({ id: 'tasks.schedule.confirm' })}
        </Button>
        <Button onClick={onCancel}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
      </div>
    </Modal>
  )
}

/** 与重复方式并排的参数列（时间 / 分钟数） */
function ParamField({ preset, onChange }: { preset: SchedulePreset; onChange: (next: SchedulePreset) => void }) {
  const intl = useIntl()

  switch (preset.kind) {
    case 'every_minutes':
      return (
        <Field label={intl.formatMessage({ id: 'tasks.schedule.field.minutes' })}>
          <NumberInput
            value={preset.minutes}
            min={1}
            max={59}
            onChange={(minutes) => onChange({ ...preset, minutes })}
          />
        </Field>
      )
    case 'hourly':
      return (
        <Field label={intl.formatMessage({ id: 'tasks.schedule.field.minute' })}>
          <NumberInput value={preset.minute} min={0} max={59} onChange={(minute) => onChange({ ...preset, minute })} />
        </Field>
      )
    case 'daily':
    case 'weekly':
    case 'monthly':
      return (
        <Field label={intl.formatMessage({ id: 'tasks.schedule.field.time' })}>
          <TextInput
            type="time"
            value={preset.time}
            onChange={(event) => {
              if (event.target.value !== '') onChange({ ...preset, time: event.target.value })
            }}
          />
        </Field>
      )
  }
}

/** Field 的无 label 元素版：星期/日期这类按钮组不能包进 <label>（点击会误触第一个按钮） */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-4">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
    </div>
  )
}

function NumberInput({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <TextInput
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(event) => {
        const next = Number(event.target.value)
        if (Number.isInteger(next) && next >= min && next <= max) onChange(next)
      }}
    />
  )
}

function ToggleChip({
  label,
  active,
  onToggle,
  className = '',
}: {
  label: string
  active: boolean
  onToggle: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`rounded-md px-2 text-xs font-medium transition-colors ${
        active ? 'bg-accent text-white' : 'border border-line text-ink-muted hover:text-ink'
      } ${className}`}
    >
      {label}
    </button>
  )
}
