import type { AssistantConfig, ScheduledTask } from '../../shared/config'
import { errorMessage } from '../../shared/errors'
import type { ActionResult } from '../../shared/ipc/contract'
import {
  partsToPlainText,
  type MessagePart,
  type TaskDelivery,
  type TaskRunRecord,
  type TaskStatus,
  type TaskTrigger,
} from '../../shared/messages'
import { cronMatches, nextRunAt, parseCron } from '../../shared/schedule'
import type { AgentRuntime } from '../agents/types'
import type { ConfigStore } from '../config/store'
import { renderTaskPrompt } from '../skills/task-prompt'
import { withDeadline, withTimeout } from '../util/async'
import type { Logger } from '../util/logger'
import type { TaskRunRepo } from './task-run-repo'

// 定时任务调度器：分钟对齐 tick，按 cron 匹配触发（错过一律跳过，不补跑——用户拍板，
// 手动「执行」是兜底）。任务定义每 tick 现读 store.current（与 chat-manager 现读 bindings
// 同一手法），配置变更即时生效，无需订阅重建。执行链路蓝本 core/auto-review.ts：
// 一次性 runtime（不注入 susie MCP，结果由本层统一投递）+ 全程留痕 + 实时上报。

/** 建会话超时 */
const SESSION_DEADLINE_MS = 60_000
/** 单次任务执行（agent turn）超时 */
const RUN_DEADLINE_MS = 600_000
/** 停机时等待在跑任务收尾的预算 */
const STOP_BUDGET_MS = 2_000

/** 任务运行时的系统指令：无人值守、输出即结果 */
const TASK_INSTRUCTION = [
  '你是 Susie 的定时任务执行器，独立运行、无人值守。',
  '执行下面给到的任务，把要发给用户的最终结果作为回复输出——输出会被原样发送。',
  '没有人会回答问题：信息不足时按合理假设执行，并在结果中说明假设。',
].join('\n')

export interface TaskSchedulerDeps {
  store: ConfigStore
  runs: TaskRunRepo
  /** 按 assistant 建一次性运行时（无 susie MCP，见 service.createTaskRuntime） */
  createRuntime: (assistant: AssistantConfig) => Promise<AgentRuntime>
  /** 出站投递（chatManager.sendMessage：发通道 + 落历史库 + 广播） */
  sendMessage: (input: { channelId: string; chatId: string; parts: MessagePart[] }) => Promise<unknown>
  /** 执行记录新增/落定上报（推送到 UI） */
  emit: (record: TaskRunRecord) => void
  log: Logger
  /** 时钟注入（测试用）；缺省 Date.now */
  now?: () => number
}

export class TaskScheduler {
  private readonly deps: TaskSchedulerDeps
  private readonly now: () => number
  private timer: NodeJS.Timeout | null = null
  /** taskId → 在跑的执行（含收尾清理）；同任务重叠触发据此跳过 */
  private readonly running = new Map<string, Promise<void>>()
  private readonly activeRuntimes = new Set<AgentRuntime>()
  private lastTickMinute = -1
  private stopped = false

  constructor(deps: TaskSchedulerDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  start(): void {
    this.armTimer()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== null) clearTimeout(this.timer)
    // 主动收尸在跑的 agent 子进程（dispose 内部自带 SIGTERM → 限时 → SIGKILL）
    for (const runtime of this.activeRuntimes) void runtime.dispose()
    const inflight = [...this.running.values()]
    if (inflight.length > 0) await withTimeout(Promise.allSettled(inflight), STOP_BUDGET_MS, undefined)
  }

  /** 手动执行一次（任务在跑时拒绝；停用的任务也允许手动跑） */
  runNow(id: string): ActionResult {
    const task = this.deps.store.current.scheduled_tasks.find((item) => item.id === id)
    if (task === undefined) return { ok: false, message: `任务不存在：${id}` }
    if (this.running.has(id)) return { ok: false, message: '任务正在执行中' }
    this.fire(task, 'manual')
    return { ok: true }
  }

  /** 全部任务的运行时状态（任务页列表用） */
  statuses(): TaskStatus[] {
    const nowMs = this.now()
    return this.deps.store.current.scheduled_tasks.map((task) => {
      const spec = parseCron(task.schedule)
      return {
        taskId: task.id,
        running: this.running.has(task.id),
        nextRunTs: task.enabled && spec !== null ? nextRunAt(spec, nowMs) : null,
        lastRun: this.deps.runs.latest(task.id),
      }
    })
  }

  /** 评估当下分钟并触发到点任务；由内部分钟定时器驱动，测试可直接调用 */
  tick(): void {
    const at = new Date(this.now())
    const minute = Math.floor(at.getTime() / 60_000)
    if (minute === this.lastTickMinute) return
    this.lastTickMinute = minute

    for (const task of this.deps.store.current.scheduled_tasks) {
      if (!task.enabled) continue
      const spec = parseCron(task.schedule)
      if (spec === null || !cronMatches(spec, at)) continue
      if (this.running.has(task.id)) {
        this.deps.log.info(`任务 ${task.id} 上一次执行未结束，本次触发跳过`)
        continue
      }
      this.fire(task, 'schedule')
    }
  }

  // ---------- 内部 ----------

  private armTimer(): void {
    if (this.stopped) return
    // 对齐下一分钟边界（+25ms 缓冲防早触发）；睡眠期间积压的点位不补——唤醒后只评估当下分钟
    const delay = 60_000 - (this.now() % 60_000) + 25
    this.timer = setTimeout(() => {
      this.tick()
      this.armTimer()
    }, delay)
  }

  private fire(task: ScheduledTask, trigger: TaskTrigger): void {
    const record = this.deps.runs.create({
      taskId: task.id,
      taskName: task.name,
      trigger,
      startedTs: this.now(),
    })
    this.deps.emit(record)
    const run = this.execute(task, record.id).finally(() => this.running.delete(task.id))
    this.running.set(task.id, run)
  }

  /** 单次执行：建 runtime → 跑任务文本 → 逐目标投递 → 落定记录。异常收敛为 error 记录，不外抛。 */
  private async execute(task: ScheduledTask, recordId: number): Promise<void> {
    let runtime: AgentRuntime | null = null
    const deliveries: TaskDelivery[] = []
    try {
      const assistant = this.deps.store.current.assistants.find((item) => item.id === task.assistant_id)
      if (assistant === undefined) throw new Error(`assistant 不存在：${task.assistant_id}`)

      // skill 引用在建 runtime 之前解析：缺失快速失败，不空耗 agent 子进程
      const prompt = renderTaskPrompt(task, assistant)

      runtime = await this.deps.createRuntime(assistant)
      this.activeRuntimes.add(runtime)
      await withDeadline(runtime.newSession(TASK_INSTRUCTION), SESSION_DEADLINE_MS, '定时任务建会话')
      const output = (await withDeadline(consumePrompt(runtime, prompt), RUN_DEADLINE_MS, '定时任务执行')).trim()
      if (output === '') throw new Error('任务执行无输出')

      for (const target of task.targets) {
        try {
          await this.deps.sendMessage({
            channelId: target.channel,
            chatId: target.chat_id,
            parts: [{ kind: 'text', text: output }],
          })
          deliveries.push({ channel: target.channel, chatId: target.chat_id, ok: true, message: null })
        } catch (error) {
          deliveries.push({ channel: target.channel, chatId: target.chat_id, ok: false, message: errorMessage(error) })
        }
      }
      const allFailed = deliveries.every((delivery) => !delivery.ok)
      if (allFailed) this.deps.log.error(`任务 ${task.id} 全部目标投递失败`)
      this.finish(recordId, {
        status: allFailed ? 'error' : 'ok',
        result: output,
        error: allFailed ? '全部目标投递失败' : null,
        deliveries,
      })
    } catch (error) {
      const detail = errorMessage(error)
      this.deps.log.error(`任务 ${task.id} 执行失败：${detail}`)
      this.finish(recordId, { status: 'error', result: null, error: detail, deliveries })
    } finally {
      if (runtime !== null) {
        this.activeRuntimes.delete(runtime)
        void runtime.dispose()
      }
    }
  }

  private finish(
    id: number,
    outcome: { status: 'ok' | 'error'; result: string | null; error: string | null; deliveries: TaskDelivery[] },
  ): void {
    try {
      const updated = this.deps.runs.finish(id, { ...outcome, finishedTs: this.now() })
      if (updated !== null) this.deps.emit(updated)
    } catch (error) {
      // 停机竞态（db 已关）只留日志，不让执行 promise 变成 unhandled rejection
      this.deps.log.error(`任务执行记录落定失败：${errorMessage(error)}`)
    }
  }
}

/** 消费单轮对话，返回完成时的累计文本；失败/取消抛出由上层收敛为 error 记录 */
async function consumePrompt(runtime: AgentRuntime, prompt: string): Promise<string> {
  for await (const turn of runtime.prompt(prompt)) {
    if (turn.status === 'cancelled') throw new Error('执行被取消')
    if (turn.status === 'failed') throw new Error(turn.error ?? '执行失败')
    if (turn.status === 'completed') return partsToPlainText(turn.parts)
  }
  throw new Error('执行未产生结果')
}
