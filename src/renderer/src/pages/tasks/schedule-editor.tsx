import { useState } from 'react'
import { useIntl } from 'react-intl'
import { nextRunAt, parseCron } from '../../../../shared/schedule'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
      <Button variant="outline" className="shrink-0" onClick={() => setOpen(true)}>
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="max-h-[70vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: 'tasks.schedule.modal.title' })}</DialogTitle>
        </DialogHeader>
        <div className="mt-4 grid grid-cols-2 gap-4">
          <Field>
            <FieldLabel htmlFor="schedule-kind">{intl.formatMessage({ id: 'tasks.schedule.field.kind' })}</FieldLabel>
            <NativeSelect
              id="schedule-kind"
              value={preset?.kind ?? 'custom'}
              onChange={(event) => switchKind(event.target.value)}
            >
              {preset === null && (
                <NativeSelectOption value="custom">
                  {intl.formatMessage({ id: 'tasks.schedule.kind.custom' })}
                </NativeSelectOption>
              )}
              {KINDS.map((kind) => (
                <NativeSelectOption key={kind} value={kind}>
                  {intl.formatMessage({ id: `tasks.schedule.kind.${kind}` })}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {preset !== null && <ParamField preset={preset} onChange={apply} />}
        </div>

        {preset?.kind === 'weekly' && (
          <FieldSet className="mt-4">
            <FieldLegend variant="label">{intl.formatMessage({ id: 'tasks.schedule.field.weekdays' })}</FieldLegend>
            <ToggleGroup
              multiple
              variant="outline"
              size="sm"
              className="w-full"
              value={preset.weekdays.map(String)}
              onValueChange={(value) => {
                if (value.length > 0) apply({ ...preset, weekdays: value.map(Number) })
              }}
            >
              {WEEKDAY_ORDER.map((day) => (
                <ToggleGroupItem key={day} value={String(day)} className="flex-1">
                  {intl.formatMessage({ id: `tasks.weekday.${day}` })}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>
        )}

        {preset?.kind === 'monthly' && (
          <FieldSet className="mt-4">
            <FieldLegend variant="label">{intl.formatMessage({ id: 'tasks.schedule.field.days' })}</FieldLegend>
            <ToggleGroup
              multiple
              variant="outline"
              size="sm"
              className="grid w-full grid-cols-7"
              value={preset.days.map(String)}
              onValueChange={(value) => {
                if (value.length > 0) apply({ ...preset, days: value.map(Number) })
              }}
            >
              {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                <ToggleGroupItem key={day} value={String(day)} className="w-full">
                  {day}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </FieldSet>
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
          <Button variant="default" onClick={() => onConfirm(cron)}>
            {intl.formatMessage({ id: 'tasks.schedule.confirm' })}
          </Button>
          <Button variant="outline" onClick={onCancel}>
            {intl.formatMessage({ id: 'common.cancel' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** 与重复方式并排的参数列（时间 / 分钟数） */
function ParamField({ preset, onChange }: { preset: SchedulePreset; onChange: (next: SchedulePreset) => void }) {
  const intl = useIntl()

  switch (preset.kind) {
    case 'every_minutes':
      return (
        <Field>
          <FieldLabel htmlFor="schedule-minutes">
            {intl.formatMessage({ id: 'tasks.schedule.field.minutes' })}
          </FieldLabel>
          <NumberInput
            id="schedule-minutes"
            value={preset.minutes}
            min={1}
            max={59}
            onChange={(minutes) => onChange({ ...preset, minutes })}
          />
        </Field>
      )
    case 'hourly':
      return (
        <Field>
          <FieldLabel htmlFor="schedule-minute">{intl.formatMessage({ id: 'tasks.schedule.field.minute' })}</FieldLabel>
          <NumberInput
            id="schedule-minute"
            value={preset.minute}
            min={0}
            max={59}
            onChange={(minute) => onChange({ ...preset, minute })}
          />
        </Field>
      )
    case 'daily':
    case 'weekly':
    case 'monthly':
      return (
        <Field>
          <FieldLabel htmlFor="schedule-time">{intl.formatMessage({ id: 'tasks.schedule.field.time' })}</FieldLabel>
          <Input
            id="schedule-time"
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

function NumberInput({
  id,
  value,
  min,
  max,
  onChange,
}: {
  id: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <Input
      id={id}
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
