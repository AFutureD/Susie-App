import type { AutoReviewConfig } from '../../shared/config'
import { partsToPlainText, type AutoReviewRecord, type InboundEnvelope } from '../../shared/messages'
import type { AgentRuntime } from '../agents/types'
import type { AutoReviewRepo } from './auto-review-repo'
import type { ConfigStore } from '../config/store'
import { withDeadline } from '../util/async'
import type { Logger } from '../util/logger'

// 智能 · 自动审核：用配置的 agent 评估待审核消息是否符合审核标准。
// 通过 → 放行；未通过 / 出错 / 超时 → 回落人工审核（fail-safe 偏保守，绝不误放行）。
// 全程在应用库留痕（auto_reviews，AutoReviewRepo）并实时上报进度供 UI 展示。

/** 单条消息的审核裁决 */
export interface AutoReviewVerdict {
  passed: boolean
  reason: string | null
}

/** 审核 agent 单轮判定的超时（超时按未通过处理，回落人工审核） */
const REVIEW_DEADLINE_MS = 60_000
/** 记录的消息文本摘要长度上限 */
const TEXT_EXCERPT_LIMIT = 500

export interface AutoReviewerDeps {
  store: ConfigStore
  reviews: AutoReviewRepo
  /** 按 auto_review 配置建一次性运行时（无 susie MCP，审核 agent 不应对外发消息） */
  createRuntime: (config: AutoReviewConfig) => Promise<AgentRuntime>
  /** 进度/结论上报（推送到 UI） */
  emit: (record: AutoReviewRecord) => void
  log: Logger
}

export class AutoReviewer {
  private readonly deps: AutoReviewerDeps

  constructor(deps: AutoReviewerDeps) {
    this.deps = deps
  }

  /** 评估一条消息；任何异常都收敛为「未通过」，由调用方回落人工审核。 */
  async review(envelope: InboundEnvelope): Promise<AutoReviewVerdict> {
    const config = this.deps.store.current.auto_review
    const { message } = envelope
    const text = partsToPlainText(message.parts).trim()
    const fileCount = message.parts.filter((part) => part.kind === 'file').length
    const excerpt = clipExcerpt(text, fileCount)
    const promptBody = text === '' ? '（消息无文本内容）' : text
    const prompt = fileCount > 0 ? `${promptBody}\n\n（消息含 ${fileCount} 个附件）` : promptBody

    // 建 running 记录并上报（UI 立刻看到「审核中」）
    const record = this.deps.reviews.create({
      channelId: message.channelId,
      chatId: message.chatId,
      senderId: message.senderId,
      sender: message.sender,
      text: excerpt,
      createdTs: Date.now(),
    })
    this.deps.emit(record)

    let runtime: AgentRuntime | null = null
    try {
      runtime = await this.deps.createRuntime(config)
      const activeRuntime = runtime
      await withDeadline(
        activeRuntime.newSession(buildInstruction(config.content)),
        REVIEW_DEADLINE_MS,
        '自动审核建会话',
      )
      const output = await withDeadline(consumePrompt(activeRuntime, prompt), REVIEW_DEADLINE_MS, '自动审核判定')
      const verdict = parseVerdict(output)
      this.finish(record.id, verdict.passed ? 'passed' : 'rejected', verdict.reason)
      return verdict
    } catch (error) {
      // 建运行时/判定失败（agent 未安装、超时、模型报错等）：不放行，回落人工审核
      this.deps.log.error(`自动审核失败，回落人工审核：${error instanceof Error ? error.message : String(error)}`)
      this.finish(record.id, 'error', '自动审核不可用')
      return { passed: false, reason: '自动审核不可用' }
    } finally {
      if (runtime !== null) void runtime.dispose()
    }
  }

  private finish(id: number, status: 'passed' | 'rejected' | 'error', reason: string | null): void {
    const updated = this.deps.reviews.finish(id, status, reason, Date.now())
    if (updated !== null) this.deps.emit(updated)
  }
}

/** 消息文本摘要（超长截断；补充附件数） */
function clipExcerpt(text: string, fileCount: number): string {
  const body = text.length > TEXT_EXCERPT_LIMIT ? `${text.slice(0, TEXT_EXCERPT_LIMIT)}…` : text
  if (body === '') return fileCount > 0 ? `（${fileCount} 个附件）` : '（无文本内容）'
  return fileCount > 0 ? `${body}（含 ${fileCount} 个附件）` : body
}

/** 审核 agent 的系统指令：嵌入审核标准，强约束输出为 PASS / REJECT: 形态 */
function buildInstruction(content: string): string {
  return [
    '你是消息安全审核员。只依据下面的审核标准，判断用户消息是否应被放行。',
    '',
    '<审核标准>',
    content,
    '</审核标准>',
    '',
    '判定规则：',
    '- 若消息违反审核标准，仅回复一行，以 "REJECT:" 开头并附一句简短理由。',
    '- 否则仅回复一行 "PASS"。',
    '不要调用任何工具，不要输出多余内容或解释。',
  ].join('\n')
}

/** 消费单轮对话，返回完成时的累计文本；失败/取消抛出以便上层回落 */
async function consumePrompt(runtime: AgentRuntime, prompt: string): Promise<string> {
  for await (const turn of runtime.prompt(prompt)) {
    if (turn.status === 'cancelled') throw new Error('审核 turn 被取消')
    if (turn.status === 'failed') throw new Error(turn.error ?? '审核 turn 失败')
    if (turn.status === 'completed') return partsToPlainText(turn.parts)
  }
  throw new Error('审核 turn 未产生结果')
}

/** 解析裁决：以 PASS 开头视为通过；其余（含 REJECT 与无法识别）视为未通过 */
function parseVerdict(output: string): AutoReviewVerdict {
  const trimmed = output.trim()
  if (/^pass\b/i.test(trimmed)) return { passed: true, reason: null }
  const rejectMatch = /^reject\s*[:：]?\s*(.*)$/is.exec(trimmed)
  if (rejectMatch !== null) {
    const reason = rejectMatch[1]?.trim()
    return { passed: false, reason: reason !== undefined && reason !== '' ? reason : '不符合审核标准' }
  }
  // 输出无法识别：保守起见不放行
  return { passed: false, reason: '审核结果无法识别' }
}
