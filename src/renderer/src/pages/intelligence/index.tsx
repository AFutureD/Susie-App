import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { Link } from 'react-router'
import type { AutoReviewConfig, ConfigState, ThinkingLevel } from '../../../../shared/config'
import { RECOMMENDED_AUTO_REVIEW, THINKING_LEVELS } from '../../../../shared/config'
import type { AgentModelOption } from '../../../../shared/messages'
import { Button, ErrorText, Field, Select, TextArea } from '../../components/form'
import { Page } from '../../components/page'
import { configStateAtom } from '../../lib/config-atoms'
import { ipc } from '../../lib/ipc'

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
    void ipc.agents.overview().then((overview) => {
      if (cancelled) return
      const installed = overview
        .filter((agent) => agent.id !== CODEX_AGENT_ID && agent.source === 'installed')
        .map((agent) => agent.id)
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
    void ipc.agents.models({ agentId }).then((options) => {
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
    const result = await ipc.config.setAutoReview({ autoReview, expectedVersion: state.version })
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
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'intelligence.autoReview.title' })}</h2>
        <Link
          to="/intelligence/history"
          className="shrink-0 rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:bg-surface"
        >
          {intl.formatMessage({ id: 'intelligence.history.open' })}
        </Link>
      </div>
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
