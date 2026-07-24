import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { AutoReviewConfig, ConfigState, ThinkingLevel } from '../../../shared/config'
import { RECOMMENDED_AUTO_REVIEW, THINKING_LEVELS } from '../../../shared/config'
import type { AgentModelOption, AutoReviewRecord, AutoReviewStatus } from '../../../shared/messages'
import { Button, ErrorText, Field, Select, TextArea } from '../components/form'
import { Page } from '../components/page'
import { configStateAtom } from '../lib/config-atoms'
import { susie } from '../lib/ipc'

/** Codex 直连 agent 的固定 id（对位 main 的 CODEX_AGENT_ID） */
const CODEX_AGENT_ID = 'codex'

export function IntelligencePage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)

  if (!state) {
    return <Page titleId="page.intelligence.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  return (
    <Page titleId="page.intelligence.title">
      <div className="flex flex-col gap-6">
        <AutoReviewCard key={`auto-review@${state.version}`} state={state} />
        <AutoReviewHistory />
      </div>
    </Page>
  )
}

function AutoReviewCard({ state }: { state: ConfigState }) {
  const intl = useIntl()
  const initial = state.config.auto_review

  const [content, setContent] = useState(initial.content)
  const [agentId, setAgentId] = useState(initial.agent_id)
  const [model, setModel] = useState(initial.model ?? '')
  const [thinkingLevel, setThinkingLevel] = useState<string>(initial.thinking_level ?? '')
  /** null = 枚举中 */
  const [agentIds, setAgentIds] = useState<string[] | null>(null)
  const [modelOptions, setModelOptions] = useState<AgentModelOption[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void susie.invoke('agents:overview').then((overview) => {
      if (cancelled) return
      const installed = overview.acp.filter((agent) => agent.installedVersion !== null).map((agent) => agent.id)
      setAgentIds([CODEX_AGENT_ID, ...installed])
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 模型候选跟随 agent 枚举（与助手表单同一机制）
  useEffect(() => {
    let cancelled = false
    setModelOptions(null)
    void susie.invoke('agents:models', { agentId }).then((options) => {
      if (!cancelled) setModelOptions(options)
    })
    return () => {
      cancelled = true
    }
  }, [agentId])

  const submit = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    const autoReview: AutoReviewConfig = {
      content,
      agent_id: agentId,
      ...(model === '' ? {} : { model }),
      ...(thinkingLevel === '' ? {} : { thinking_level: thinkingLevel as ThinkingLevel }),
    }
    const result = await susie.invoke('config:set-auto-review', { autoReview, expectedVersion: state.version })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    setSaved(true)
  }

  // 编辑既有配置时，当前值可能不在枚举结果里（agent 卸载 / 手改 config）：保留为额外选项防误改
  const knownAgents = agentIds ?? []
  const agentOptions = agentId !== '' && !knownAgents.includes(agentId) ? [agentId, ...knownAgents] : knownAgents
  const models = modelOptions ?? []
  const modelMissing = model !== '' && !models.some((option) => option.value === model)

  return (
    <section className="rounded-xl border border-line bg-raised p-5">
      <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'intelligence.autoReview.title' })}</h2>
      <p className="mt-1 text-xs leading-5 text-ink-muted">
        {intl.formatMessage({ id: 'intelligence.autoReview.desc' })}
      </p>

      <div className="mt-4 flex flex-col gap-3">
        <Field
          label={intl.formatMessage({ id: 'intelligence.autoReview.content' })}
          hint={intl.formatMessage({ id: 'intelligence.autoReview.content.hint' })}
        >
          <TextArea
            rows={5}
            value={content}
            onChange={(event) => {
              setContent(event.target.value)
              setSaved(false)
            }}
          />
        </Field>

        <div className="grid grid-cols-3 gap-3">
          <Field
            label={intl.formatMessage({ id: 'intelligence.autoReview.field.agent' })}
            hint={intl.formatMessage({ id: 'intelligence.autoReview.field.agent.hint' })}
          >
            <Select
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value)
                setModel('')
                setSaved(false)
              }}
            >
              {agentOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={intl.formatMessage({ id: 'intelligence.autoReview.field.model' })}
            hint={intl.formatMessage({ id: 'intelligence.autoReview.field.model.hint' })}
          >
            <Select
              value={model}
              onChange={(event) => {
                setModel(event.target.value)
                setSaved(false)
              }}
            >
              <option value="">
                {intl.formatMessage({
                  id: modelOptions === null ? 'assistants.models.loading' : 'assistants.model.default',
                })}
              </option>
              {modelMissing && <option value={model}>{model}</option>}
              {models.map((option) => (
                <option key={option.value} value={option.value} title={option.description}>
                  {option.name === option.value ? option.value : `${option.name} · ${option.value}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={intl.formatMessage({ id: 'intelligence.autoReview.field.thinking' })}
            hint={intl.formatMessage({ id: 'intelligence.autoReview.field.thinking.hint' })}
          >
            <Select
              value={thinkingLevel}
              onChange={(event) => {
                setThinkingLevel(event.target.value)
                setSaved(false)
              }}
            >
              <option value="">{intl.formatMessage({ id: 'assistants.thinking.default' })}</option>
              {THINKING_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <p className="text-xs text-ink-muted/80">
          {intl.formatMessage(
            { id: 'intelligence.autoReview.recommended' },
            {
              agent: RECOMMENDED_AUTO_REVIEW.agent_id,
              model: RECOMMENDED_AUTO_REVIEW.model,
              thinking: RECOMMENDED_AUTO_REVIEW.thinking_level,
            },
          )}
        </p>

        <ErrorText message={error} />
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={busy || content.trim() === '' || agentId === ''}
            onClick={() => void submit()}
          >
            {intl.formatMessage({ id: 'common.save' })}
          </Button>
          {saved && (
            <span className="text-xs text-accent">{intl.formatMessage({ id: 'intelligence.autoReview.saved' })}</span>
          )}
        </div>
      </div>
    </section>
  )
}

/** 自动审核记录状态 → 徽章样式 */
const STATUS_BADGE: Record<AutoReviewStatus, string> = {
  running: 'bg-accent/10 text-accent',
  passed: 'bg-emerald-500/10 text-emerald-600',
  rejected: 'bg-amber-500/10 text-amber-600',
  error: 'bg-red-500/10 text-red-500',
}

function AutoReviewHistory() {
  const intl = useIntl()
  const [records, setRecords] = useState<AutoReviewRecord[] | null>(null)

  useEffect(() => {
    let alive = true
    void susie.invoke('autoreview:list', { limit: 100 }).then((list) => {
      if (alive) setRecords(list)
    })
    // 新记录/状态更新按 id 合并（进行中 → 结论）
    const off = susie.on('autoreview:record', (record) => {
      setRecords((prev) => {
        const base = prev ?? []
        const rest = base.filter((item) => item.id !== record.id)
        return [record, ...rest].toSorted((a, b) => b.id - a.id)
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return (
    <section className="rounded-xl border border-line bg-raised p-5">
      <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'intelligence.history.title' })}</h2>
      <p className="mt-1 text-xs leading-5 text-ink-muted">{intl.formatMessage({ id: 'intelligence.history.hint' })}</p>

      {records !== null && records.length === 0 && (
        <p className="mt-3 text-sm text-ink-muted">{intl.formatMessage({ id: 'intelligence.history.empty' })}</p>
      )}

      {records !== null && records.length > 0 && (
        <div className="mt-3 divide-y divide-line/60">
          {records.map((record) => (
            <AutoReviewRow key={record.id} record={record} />
          ))}
        </div>
      )}
    </section>
  )
}

function AutoReviewRow({ record }: { record: AutoReviewRecord }) {
  const intl = useIntl()
  const when = new Date(record.decidedTs ?? record.createdTs).toLocaleString()

  return (
    <div className="flex items-start gap-3 py-2.5">
      <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_BADGE[record.status]}`}>
        {intl.formatMessage({ id: `intelligence.history.status.${record.status}` })}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="truncate">{record.sender ?? record.senderId ?? '未知用户'}</span>
          <span className="font-mono">{record.chatId}</span>
          <span className="shrink-0">{when}</span>
        </div>
        <p className="mt-0.5 truncate text-sm">{record.text}</p>
        {record.reason !== null && record.status !== 'running' && (
          <p className="mt-0.5 text-xs text-ink-muted/80">→ {record.reason}</p>
        )}
      </div>
    </div>
  )
}
