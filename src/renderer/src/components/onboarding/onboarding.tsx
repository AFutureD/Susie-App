import { useCallback, useEffect, useMemo, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { canonicalizeBindings, expandBindings, type BindingAssignments } from '../../../../shared/bindings'
import { decodeChatId } from '../../../../shared/chat-id'
import { DEFAULT_ASSISTANT_ID, type ConfigState } from '../../../../shared/config'
import type { ChatInfo } from '../../../../shared/messages'
import { configStateAtom } from '../../lib/config-atoms'
import { susie } from '../../lib/ipc'
import { channelStatusesAtom } from '../../lib/service-atoms'
import { Button, ErrorText, Field, TextInput } from '../form'
import { OwnerBindPanel } from '../owner-bind'
import { ONBOARDING_DONE_KEY, onboardingStepFor } from './model'

// 首启引导：三步（添加频道 → 绑定 owner → 会话绑定），把「频道页 + 用户管理 + 会话绑定面板」
// 的最小路径串起来。config 仍是唯一事实源：向导所有写操作走既有 IPC，界面随 config:state 广播重派生。
// 完成/跳过后写 localStorage 标记，之后不再出现。

type WizardStep = 'pending' | 'channel' | 'owner' | 'binding' | 'done' | 'closed'

export function OnboardingOverlay() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)
  const [step, setStep] = useState<WizardStep>('pending')
  const [channelId, setChannelId] = useState<string | null>(null)
  const [botUsername, setBotUsername] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)

  // 首次拿到配置时决定是否进入向导；此后步骤只由向导内部推进
  useEffect(() => {
    if (step !== 'pending' || state === null) return
    const done = localStorage.getItem(ONBOARDING_DONE_KEY) !== null
    const next = onboardingStepFor(state, done)
    if (next === null) {
      // 配置已成形（如手写 config.toml）→ 补标记，避免以后清空绑定时误弹
      if (!done && state.lastError === null) localStorage.setItem(ONBOARDING_DONE_KEY, '1')
      setStep('closed')
      return
    }
    if (next !== 'channel') setChannelId(Object.keys(state.config.channels)[0] ?? null)
    setStep(next)
  }, [step, state])

  // owner/绑定步需要 bot 深链；引导中途退出后恢复时，用已存 token 反查 username
  useEffect(() => {
    if ((step !== 'owner' && step !== 'binding') || botUsername !== null || channelId === null || state === null) return
    const settings = state.config.channels[channelId]
    if (settings === undefined) return
    let alive = true
    void susie.invoke('channels:resolve-username', { token: settings.token }).then((result) => {
      if (!alive) return
      if (result.ok) setBotUsername(result.username)
      else setLinkError(result.message)
    })
    return () => {
      alive = false
    }
  }, [step, botUsername, channelId, state])

  const finish = useCallback((): void => {
    localStorage.setItem(ONBOARDING_DONE_KEY, '1')
    setStep('closed')
  }, [])

  if (step === 'pending' || step === 'closed' || state === null) return null

  // 频道在引导期间被外部删除 → 退回第 1 步
  const channelReady = channelId !== null && channelId in state.config.channels
  const effectiveStep = (step === 'owner' || step === 'binding') && !channelReady ? 'channel' : step

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      <header className="app-drag h-12 shrink-0" />
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-8 pb-10">
        <div className="w-full max-w-xl">
          <div className="mb-6">
            <h1 className="text-xl font-semibold">{intl.formatMessage({ id: 'onboarding.welcome.title' })}</h1>
            <p className="mt-1 text-sm text-ink-muted">{intl.formatMessage({ id: 'onboarding.welcome.subtitle' })}</p>
          </div>

          {effectiveStep === 'channel' && (
            <ChannelStep
              state={state}
              onCreated={(id, username) => {
                setChannelId(id)
                setBotUsername(username)
                setStep('owner')
              }}
            />
          )}
          {effectiveStep === 'owner' && channelId !== null && (
            <OwnerStep
              state={state}
              channelId={channelId}
              botUsername={botUsername}
              linkError={linkError}
              onBound={() => setStep('binding')}
            />
          )}
          {effectiveStep === 'binding' && channelId !== null && (
            <BindingStep
              state={state}
              channelId={channelId}
              botUsername={botUsername}
              linkError={linkError}
              onFinish={() => setStep('done')}
            />
          )}
          {effectiveStep === 'done' && <DoneStep onClose={finish} />}

          {effectiveStep !== 'done' && (
            <div className="mt-8">
              <button
                type="button"
                onClick={finish}
                className="text-xs text-ink-muted underline-offset-2 hover:underline"
              >
                {intl.formatMessage({ id: 'onboarding.skip' })}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- 第 1 步：添加频道（只填 token） ----------

function ChannelStep({
  state,
  onCreated,
}: {
  state: ConfigState
  onCreated: (channelId: string, username: string) => void
}) {
  const intl = useIntl()
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const trimmed = token.trim()
    // 用 token 问 getMe：既校验 token，又拿 username 作频道 ID 与深链
    const resolved = await susie.invoke('channels:resolve-username', { token: trimmed })
    if (!resolved.ok) {
      setBusy(false)
      setError(intl.formatMessage({ id: 'channels.resolve.failed' }, { detail: resolved.message }))
      return
    }
    const result = await susie.invoke('config:upsert-channel', {
      id: resolved.username,
      settings: { type: 'telegram_bot', token: trimmed, enabled: true, drop_pending_updates: false },
      expectedVersion: state.version,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onCreated(resolved.username, resolved.username)
  }

  return (
    <section className="rounded-xl border border-line bg-raised p-5">
      <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'onboarding.step.channel' })}</h2>
      <ol className="mt-3 flex list-decimal flex-col gap-2 pl-5 text-sm leading-6 text-ink-muted">
        <li>{intl.formatMessage({ id: 'onboarding.channel.guide.step1' })}</li>
        <li>{intl.formatMessage({ id: 'onboarding.channel.guide.step2' })}</li>
      </ol>
      <div className="mt-3">
        <Button onClick={() => void susie.invoke('app:open-external', { url: 'https://t.me/BotFather' })}>
          {intl.formatMessage({ id: 'onboarding.channel.guide.open' })}
        </Button>
      </div>

      <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4">
        <Field label={intl.formatMessage({ id: 'channels.field.token' })}>
          <TextInput
            value={token}
            autoFocus
            placeholder="123456:bot-token"
            onChange={(event) => setToken(event.target.value)}
          />
        </Field>
        <ErrorText message={error} />
        <div>
          <Button variant="primary" disabled={busy || token.trim() === ''} onClick={() => void submit()}>
            {intl.formatMessage({ id: busy ? 'onboarding.channel.connecting' : 'onboarding.channel.submit' })}
          </Button>
        </div>
      </div>
    </section>
  )
}

// ---------- 第 2 步：绑定 owner ----------

function OwnerStep({
  state,
  channelId,
  botUsername,
  linkError,
  onBound,
}: {
  state: ConfigState
  channelId: string
  botUsername: string | null
  linkError: string | null
  onBound: () => void
}) {
  const intl = useIntl()
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'onboarding.step.owner' })}</h2>
        <p className="mt-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'ownerBind.subtitle' })}</p>
      </div>
      <div className="rounded-xl border border-line bg-raised p-4">
        <OwnerBindPanel
          state={state}
          channelId={channelId}
          botUsername={botUsername}
          linkError={linkError}
          onBound={onBound}
        />
      </div>
    </section>
  )
}

// ---------- 第 3 步：会话绑定 ----------

function BindingStep({
  state,
  channelId,
  botUsername,
  linkError,
  onFinish,
}: {
  state: ConfigState
  channelId: string
  botUsername: string | null
  linkError: string | null
  onFinish: () => void
}) {
  const intl = useIntl()
  const [mode, setMode] = useState<'choose' | 'listen'>('choose')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // schema 默认保证 assistants 至少有 default；仍以现有列表为准兜底
  const assistantId =
    state.config.assistants.find((assistant) => assistant.id === DEFAULT_ASSISTANT_ID)?.id ??
    state.config.assistants[0]?.id ??
    DEFAULT_ASSISTANT_ID

  const submit = useCallback(
    async (mutate: (assignments: BindingAssignments) => void): Promise<boolean> => {
      if (busy) return false
      setBusy(true)
      const assignments = expandBindings(state.config.bindings)
      mutate(assignments)
      const result = await susie.invoke('config:set-bindings', {
        bindings: canonicalizeBindings(assignments),
        expectedVersion: state.version,
      })
      setBusy(false)
      if (!result.ok) {
        setError(result.conflict ? intl.formatMessage({ id: 'bindings.error.conflictRefreshed' }) : result.message)
        return false
      }
      setError(null)
      return true
    },
    [busy, state.config.bindings, state.version, intl],
  )

  const bindAll = async (): Promise<void> => {
    const ok = await submit((assignments) => {
      assignments.wildcard[channelId] = { assistantId, onlyMention: true, sendOutput: false }
    })
    if (ok) onFinish()
  }

  const bindChat = (chatId: string): void => {
    void submit((assignments) => {
      const channelExact = (assignments.exact[channelId] ??= {})
      channelExact[chatId] = { assistantId, onlyMention: true, sendOutput: false }
    })
  }

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'onboarding.step.binding' })}</h2>
        <p className="mt-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'onboarding.binding.subtitle' })}</p>
      </div>

      {mode === 'choose' ? (
        <>
          <OptionCard
            title={intl.formatMessage({ id: 'onboarding.binding.all.title' })}
            desc={intl.formatMessage({ id: 'onboarding.binding.all.desc' })}
            disabled={busy}
            onPick={() => void bindAll()}
          />
          <OptionCard
            title={intl.formatMessage({ id: 'onboarding.binding.some.title' })}
            desc={intl.formatMessage({ id: 'onboarding.binding.some.desc' })}
            disabled={busy}
            onPick={() => setMode('listen')}
          />
          <ErrorText message={error} />
        </>
      ) : (
        <ListenPanel
          state={state}
          channelId={channelId}
          botUsername={botUsername}
          linkError={linkError}
          busy={busy}
          error={error}
          onBind={bindChat}
          onBack={() => setMode('choose')}
          onFinish={onFinish}
        />
      )}
    </section>
  )
}

function OptionCard({
  title,
  desc,
  disabled,
  onPick,
}: {
  title: string
  desc: string
  disabled: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onPick}
      className="rounded-xl border border-line bg-raised p-4 text-left transition-colors hover:border-accent/60 disabled:opacity-50"
    >
      <span className="block text-sm font-semibold">{title}</span>
      <span className="mt-1 block text-xs leading-5 text-ink-muted">{desc}</span>
    </button>
  )
}

// ---------- 监听新会话（仅指定会话模式） ----------

/** 该频道的历史会话列表：初次拉取 + 新消息事件刷新，按最近活跃排序 */
function useChannelChats(channelId: string): ChatInfo[] {
  const [chats, setChats] = useState<ChatInfo[]>([])
  useEffect(() => {
    let alive = true
    const refresh = (): void => {
      void susie.invoke('history:chats').then((list) => {
        if (!alive) return
        setChats(list.filter((chat) => chat.channelId === channelId).toSorted((a, b) => b.lastTs - a.lastTs))
      })
    }
    refresh()
    const unsubscribe = susie.on('history:message', refresh)
    return () => {
      alive = false
      unsubscribe()
    }
  }, [channelId])
  return chats
}

function ListenPanel({
  state,
  channelId,
  botUsername,
  linkError,
  busy,
  error,
  onBind,
  onBack,
  onFinish,
}: {
  state: ConfigState
  channelId: string
  botUsername: string | null
  linkError: string | null
  busy: boolean
  error: string | null
  onBind: (chatId: string) => void
  onBack: () => void
  onFinish: () => void
}) {
  const intl = useIntl()
  const chats = useChannelChats(channelId)
  const statuses = useAtomValue(channelStatusesAtom)
  const status = statuses.find((item) => item.id === channelId)

  const bound = useMemo(
    () => new Set(Object.keys(expandBindings(state.config.bindings).exact[channelId] ?? {})),
    [state.config.bindings, channelId],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border border-line bg-raised p-4">
        <p className="text-sm leading-6 text-ink-muted">{intl.formatMessage({ id: 'onboarding.listen.hint' })}</p>
        <div className="mt-3 flex items-center gap-3">
          <Button
            variant="primary"
            disabled={botUsername === null}
            onClick={() => void susie.invoke('app:open-external', { url: `https://t.me/${botUsername ?? ''}` })}
          >
            {intl.formatMessage({ id: 'onboarding.listen.open' })}
          </Button>
          {botUsername !== null && (
            <span className="font-mono text-xs text-ink-muted select-text">t.me/{botUsername}</span>
          )}
        </div>
        {linkError !== null && botUsername === null && (
          <p className="mt-2 text-xs text-red-500">
            {intl.formatMessage({ id: 'onboarding.listen.linkFailed' }, { detail: linkError })}
          </p>
        )}
        {status?.state === 'error' && status.detail !== null && (
          <p className="mt-2 text-xs text-red-500">
            {intl.formatMessage({ id: 'onboarding.listen.channelError' }, { detail: status.detail })}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-line bg-raised">
        {chats.length === 0 ? (
          <div className="flex items-center gap-2 p-4 text-sm text-ink-muted">
            <span className="size-2 animate-pulse rounded-full bg-amber-500" />
            {intl.formatMessage({ id: 'onboarding.listen.waiting' })}
          </div>
        ) : (
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto p-2">
            {chats.map((chat) => {
              const isBound = bound.has(chat.chatId)
              const typeLabel = chatTypeLabel(intl, decodeChatId(chat.chatId)?.chatType ?? null)
              return (
                <div key={chat.chatId} className="flex items-center gap-3 rounded-md px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${chat.name === null ? 'font-mono text-xs' : ''}`}>
                      {chat.name ?? chat.chatId}
                    </span>
                    {typeLabel !== null && <span className="block text-[11px] text-ink-muted">{typeLabel}</span>}
                  </div>
                  {isBound ? (
                    <span className="shrink-0 text-xs font-medium text-emerald-600">
                      {intl.formatMessage({ id: 'onboarding.listen.bound' })}
                    </span>
                  ) : (
                    <Button disabled={busy} onClick={() => onBind(chat.chatId)}>
                      {intl.formatMessage({ id: 'onboarding.listen.bind' })}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <p className="text-xs leading-5 text-ink-muted/70">
        {intl.formatMessage({ id: 'onboarding.listen.group.hint' })}
      </p>
      <ErrorText message={error} />
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || bound.size === 0} onClick={onFinish}>
          {intl.formatMessage({ id: 'onboarding.listen.finish' })}
        </Button>
        <Button disabled={busy} onClick={onBack}>
          {intl.formatMessage({ id: 'onboarding.listen.back' })}
        </Button>
      </div>
    </div>
  )
}

function chatTypeLabel(intl: ReturnType<typeof useIntl>, chatType: string | null): string | null {
  switch (chatType) {
    case 'private':
      return intl.formatMessage({ id: 'bindings.type.private' })
    case 'group':
      return intl.formatMessage({ id: 'bindings.type.group' })
    case 'supergroup':
      return intl.formatMessage({ id: 'bindings.type.supergroup' })
    case 'channel':
      return intl.formatMessage({ id: 'bindings.type.channel' })
    case 'sender':
      return intl.formatMessage({ id: 'bindings.type.sender' })
    default:
      return null
  }
}

// ---------- 完成 ----------

function DoneStep({ onClose }: { onClose: () => void }) {
  const intl = useIntl()
  return (
    <section className="rounded-xl border border-line bg-raised p-6 text-center">
      <div className="text-3xl">🎉</div>
      <h2 className="mt-2 text-base font-semibold">{intl.formatMessage({ id: 'onboarding.done.title' })}</h2>
      <p className="mt-2 text-sm leading-6 text-ink-muted">{intl.formatMessage({ id: 'onboarding.done.desc' })}</p>
      <div className="mt-5">
        <Button variant="primary" onClick={onClose}>
          {intl.formatMessage({ id: 'onboarding.done.cta' })}
        </Button>
      </div>
    </section>
  )
}
