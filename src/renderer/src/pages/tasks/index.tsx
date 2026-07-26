import { useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { Link } from 'react-router'
import type { ConfigState, ScheduledTask } from '../../../../shared/config'
import type { ChatInfo, TaskStatus } from '../../../../shared/messages'
import { Button, ErrorText, Field, FieldGroup, Select, TextArea, TextInput } from '../../components/form'
import { Page, PlaceholderCard } from '../../components/page'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc } from '../../lib/ipc'
import { useConfigMutation } from '../../lib/ipc-mutation'
import { useChatsQuery, useIpcQuery } from '../../lib/ipc-query'
import { toast } from '../../lib/toast'
import { decodeSkillOption, encodeSkillOption } from '../skills/model'
import { RunStatusBadge } from './history'
import { DEFAULT_CRON, describeSchedule, newTaskId } from './model'
import { ScheduleEditor } from './schedule-editor'
import { TargetPicker } from './target-picker'

/** 手动执行一次；在跑/任务不存在时 toast 拒绝原因 */
async function runTask(task: ScheduledTask): Promise<void> {
  const result = await ipc.tasks.run({ id: task.id })
  if (!result.ok) toast(result.message, 'error')
}

export function TasksPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const mutation = useConfigMutation()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  // 状态随执行记录事件与配置变更（调度改动影响下次触发时间）失效重查
  const statuses = useIpcQuery('tasks.statuses', () => ipc.tasks.statuses(), {
    invalidateOn: ['tasks.run', 'config.state'],
  })
  const chats = useChatsQuery()

  if (!state) {
    return <Page titleId="page.tasks.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  const tasks = state.config.scheduled_tasks
  const statusMap = new Map((statuses.data ?? []).map((status) => [status.taskId, status]))
  const chatList = chats.data ?? []

  const deleteTask = async (task: ScheduledTask) => {
    if (!window.confirm(intl.formatMessage({ id: 'tasks.deleteConfirm' }, { name: task.name }))) return
    await mutation.run((expectedVersion) => ipc.config.deleteScheduledTask({ id: task.id, expectedVersion }))
  }

  const toggleTask = async (task: ScheduledTask) => {
    await mutation.run((expectedVersion) =>
      ipc.config.upsertScheduledTask({ task: { ...task, enabled: !task.enabled }, expectedVersion }),
    )
  }

  return (
    <Page
      titleId="page.tasks.title"
      actions={
        <div className="flex gap-2">
          <Link
            to="/tasks/history"
            className="rounded-md border border-line px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-raised"
          >
            {intl.formatMessage({ id: 'tasks.history.open' })}
          </Link>
          <Button variant="primary" onClick={() => setEditing(editing === 'new' ? null : 'new')}>
            {intl.formatMessage({ id: 'tasks.add' })}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {tasks.length === 0 && editing !== 'new' && <PlaceholderCard messageId="tasks.empty" />}

        {tasks.map((task) => {
          const status = statusMap.get(task.id)
          return (
            <div key={task.id} className="rounded-xl border border-line bg-raised p-5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold">{task.name}</span>
                    <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                      {task.assistant_id}
                    </span>
                    {task.skill !== undefined && (
                      <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                        {intl.formatMessage({ id: 'tasks.skill.badge' }, { name: task.skill.name })}
                      </span>
                    )}
                    {status?.running === true && (
                      <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-accent">
                        {intl.formatMessage({ id: 'tasks.running' })}
                      </span>
                    )}
                    {!task.enabled && (
                      <span className="rounded bg-line/60 px-1.5 py-0.5 text-[11px] font-medium text-ink-muted">
                        {intl.formatMessage({ id: 'tasks.disabled' })}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 flex gap-3 text-xs text-ink-muted">
                    <span className="shrink-0">{describeSchedule(intl, task.schedule)}</span>
                    <span className="truncate">{targetSummary(task, chatList)}</span>
                  </div>
                  <TaskMetaLine task={task} status={status} />
                </div>
                <Button disabled={status?.running === true} onClick={() => void runTask(task)}>
                  {intl.formatMessage({ id: 'tasks.runNow' })}
                </Button>
                <Button onClick={() => void toggleTask(task)}>
                  {intl.formatMessage({ id: task.enabled ? 'tasks.disable' : 'tasks.enable' })}
                </Button>
                <Button onClick={() => setEditing(editing === task.id ? null : task.id)}>
                  {intl.formatMessage({ id: 'common.edit' })}
                </Button>
                <Button variant="danger" onClick={() => void deleteTask(task)}>
                  {intl.formatMessage({ id: 'common.delete' })}
                </Button>
              </div>
              {editing === task.id && (
                <TaskForm
                  key={`${task.id}@${state.version}`}
                  initial={task}
                  state={state}
                  chats={chatList}
                  onDone={() => setEditing(null)}
                />
              )}
            </div>
          )
        })}

        {editing === 'new' && (
          <div className="rounded-xl border border-line bg-raised p-5">
            <TaskForm state={state} chats={chatList} onDone={() => setEditing(null)} />
          </div>
        )}
      </div>
    </Page>
  )
}

function TaskMetaLine({ task, status }: { task: ScheduledTask; status: TaskStatus | undefined }) {
  const intl = useIntl()
  // 停用任务不显示下次触发（「已停用」徽章已说明）；启用但表达式无解（如 2 月 30 日）提示不再触发
  const next = !task.enabled
    ? null
    : status?.nextRunTs != null
      ? intl.formatMessage({ id: 'tasks.nextRun' }, { time: new Date(status.nextRunTs).toLocaleString() })
      : intl.formatMessage({ id: 'tasks.nextRun.none' })
  const last = status?.lastRun
  return (
    <div className="mt-1 flex items-center gap-3 text-xs text-ink-muted/80">
      {next !== null && <span>{next}</span>}
      {last != null ? (
        <span className="flex items-center gap-1.5">
          {intl.formatMessage({ id: 'tasks.lastRun' }, { time: new Date(last.startedTs).toLocaleString() })}
          <RunStatusBadge status={last.status} />
        </span>
      ) : (
        <span>{intl.formatMessage({ id: 'tasks.lastRun.none' })}</span>
      )}
    </div>
  )
}

/** 内容模式切换 chip（自定义 | 使用技能） */
function ModeChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        active ? 'bg-accent text-white' : 'border border-line text-ink-muted hover:text-ink'
      }`}
    >
      {label}
    </button>
  )
}

/** 投递目标摘要：优先显示会话名，最多 3 个，超出计数 */
function targetSummary(task: ScheduledTask, chats: ChatInfo[]): string {
  const names = task.targets.map((target) => {
    const chat = chats.find((item) => item.channelId === target.channel && item.chatId === target.chat_id)
    return chat?.name ?? target.chat_id
  })
  const shown = names.slice(0, 3).join('、')
  return names.length > 3 ? `${shown} 等 ${names.length} 个会话` : `→ ${shown}`
}

function TaskForm({
  initial,
  state,
  chats,
  onDone,
}: {
  initial?: ScheduledTask
  state: ConfigState
  chats: ChatInfo[]
  onDone: () => void
}) {
  const intl = useIntl()
  const assistants = state.config.assistants.map((assistant) => assistant.id)
  const [name, setName] = useState(initial?.name ?? '')
  const [content, setContent] = useState(initial?.content ?? '')
  const [mode, setMode] = useState<'custom' | 'skill'>(initial?.skill !== undefined ? 'skill' : 'custom')
  const [skillValue, setSkillValue] = useState(
    initial?.skill !== undefined ? encodeSkillOption(initial.skill.scope, initial.skill.dir, initial.skill.name) : '',
  )
  const [assistantId, setAssistantId] = useState(initial?.assistant_id ?? assistants[0] ?? '')
  const [schedule, setSchedule] = useState(initial?.schedule ?? DEFAULT_CRON)
  const [targets, setTargets] = useState(initial?.targets ?? [])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 技能候选：所选助手的 agent 能读取的技能（工作目录 + 全局；main 侧按映射表过滤）
  const assistantSkills = useIpcQuery(
    `skills.forAssistant:${assistantId}`,
    () => ipc.skills.listForAssistant({ id: assistantId }),
    { invalidateOn: ['config.state'], enabled: assistantId !== '' },
  )

  const submit = async () => {
    setBusy(true)
    setError(null)
    const skill = mode === 'skill' ? decodeSkillOption(skillValue) : null
    const task: ScheduledTask = {
      id: initial?.id ?? newTaskId(),
      name: name.trim(),
      content: content.trim(),
      ...(skill !== null ? { skill } : {}),
      assistant_id: assistantId,
      schedule,
      targets,
      enabled: initial?.enabled ?? true,
    }
    const result = await ipc.config.upsertScheduledTask({ task, expectedVersion: state.version })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onDone()
  }

  // 编辑既有任务时 assistant 可能已被删除：保留为额外选项防误改
  const assistantOptions =
    assistantId !== '' && !assistants.includes(assistantId) ? [assistantId, ...assistants] : assistants

  const workspaceOptions = (assistantSkills.data?.workspace ?? []).map((entry) => ({
    value: encodeSkillOption('assistant', entry.dir, entry.dirName),
    label: `${entry.name}（${entry.dir}）`,
  }))
  const globalOptions = (assistantSkills.data?.global ?? []).map((entry) => ({
    value: encodeSkillOption('global', entry.dir, entry.dirName),
    label: `${entry.name}（${entry.dir}）`,
  }))
  const skillOptionCount = workspaceOptions.length + globalOptions.length
  // 编辑既有任务时引用的技能可能已不在候选（被删/换助手）：保留为额外选项防误改
  const skillMissing =
    skillValue !== '' &&
    !workspaceOptions.some((option) => option.value === skillValue) &&
    !globalOptions.some((option) => option.value === skillValue)
  const missingSkill = skillMissing ? decodeSkillOption(skillValue) : null
  const missingSkillLabel = missingSkill !== null ? `${missingSkill.name}（${missingSkill.dir}）` : skillValue

  return (
    <div className="mt-4 flex flex-col gap-4 border-t border-line pt-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label={intl.formatMessage({ id: 'tasks.field.name' })}>
          <TextInput value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field
          label={intl.formatMessage({ id: 'tasks.field.assistant' })}
          hint={intl.formatMessage({ id: 'tasks.field.assistant.hint' })}
        >
          <Select
            value={assistantId}
            onChange={(event) => {
              // 换助手后技能候选随 agent 变化，旧选择大概率无效：清空重选
              setAssistantId(event.target.value)
              setSkillValue('')
            }}
          >
            {assistantOptions.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <FieldGroup label={intl.formatMessage({ id: 'tasks.field.schedule' })}>
        <ScheduleEditor value={schedule} onChange={setSchedule} />
      </FieldGroup>
      <FieldGroup label={intl.formatMessage({ id: 'tasks.field.targets' })}>
        <TargetPicker
          channelIds={Object.keys(state.config.channels)}
          chats={chats}
          targets={targets}
          onChange={setTargets}
        />
      </FieldGroup>
      <FieldGroup
        label={intl.formatMessage({ id: 'tasks.field.content' })}
        hint={intl.formatMessage({ id: mode === 'custom' ? 'tasks.field.content.hint' : 'tasks.field.skill.hint' })}
      >
        <div className="mb-2 flex gap-1.5">
          <ModeChip
            label={intl.formatMessage({ id: 'tasks.content.mode.custom' })}
            active={mode === 'custom'}
            onClick={() => setMode('custom')}
          />
          <ModeChip
            label={intl.formatMessage({ id: 'tasks.content.mode.skill' })}
            active={mode === 'skill'}
            onClick={() => setMode('skill')}
          />
        </div>
        {mode === 'custom' ? (
          // FieldGroup 不产生 label 关联：aria-label 保住可访问名（e2e getByLabel 依赖）
          <TextArea
            rows={5}
            aria-label={intl.formatMessage({ id: 'tasks.field.content' })}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <Select value={skillValue} onChange={(event) => setSkillValue(event.target.value)}>
              <option value="">
                {intl.formatMessage({
                  id:
                    assistantSkills.data === null
                      ? 'tasks.skill.loading'
                      : skillOptionCount === 0
                        ? 'tasks.skill.none'
                        : 'tasks.skill.placeholder',
                })}
              </option>
              {skillMissing && <option value={skillValue}>{missingSkillLabel}</option>}
              {workspaceOptions.length > 0 && (
                <optgroup label={intl.formatMessage({ id: 'tasks.skill.optgroup.workspace' })}>
                  {workspaceOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              )}
              {globalOptions.length > 0 && (
                <optgroup label={intl.formatMessage({ id: 'tasks.skill.optgroup.global' })}>
                  {globalOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
            <TextArea
              rows={3}
              placeholder={intl.formatMessage({ id: 'tasks.field.skill.extra' })}
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </div>
        )}
      </FieldGroup>
      <ErrorText message={error} />
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={
            busy ||
            name.trim() === '' ||
            assistantId === '' ||
            targets.length === 0 ||
            (mode === 'custom' ? content.trim() === '' : decodeSkillOption(skillValue) === null)
          }
          onClick={() => void submit()}
        >
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        <Button onClick={onDone}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
      </div>
    </div>
  )
}
