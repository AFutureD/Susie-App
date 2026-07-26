import { useCallback, useMemo, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { canonicalizeBindings, expandBindings, type BindingAssignments } from '../../../../shared/bindings'
import { decodeChatId } from '../../../../shared/chat-id'
import { DEFAULT_ASSISTANT_ID, type ConfigState } from '../../../../shared/config'
import type { ChatInfo } from '../../../../shared/messages'
import { ipc } from '../../lib/ipc'
import { useChatsQuery } from '../../lib/ipc-query'
import { channelStatusesAtom } from '../../lib/service-atoms'
import { Button, ErrorText } from '../form'

// 向导第 3 步：会话绑定（全部会话默认 / 仅指定会话 + 监听新会话面板）。

export function BindingStep({
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
      const result = await ipc.config.setBindings({
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

/** 该频道的历史会话列表：共享查询缓存（history.message 事件自动失效），按最近活跃排序 */
function useChannelChats(channelId: string): ChatInfo[] {
  const { data } = useChatsQuery()
  return useMemo(
    () => (data ?? []).filter((chat) => chat.channelId === channelId).toSorted((a, b) => b.lastTs - a.lastTs),
    [data, channelId],
  )
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
            onClick={() => void ipc.app.openExternal({ url: `https://t.me/${botUsername ?? ''}` })}
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
