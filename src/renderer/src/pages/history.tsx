import { useCallback, useEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ChatInfo, MessagePart, StoredMessage } from '../../../shared/messages'
import { Button, TextInput } from '../components/form'
import { ipc, onIpcEvent } from '../lib/ipc'

function chatKey(channelId: string, chatId: string): string {
  return `${channelId}/${chatId}`
}

function formatTime(ts: number): string {
  const date = new Date(ts)
  return date.toLocaleString('zh-Hans-CN', { hour12: false })
}

function PartView({ part }: { part: MessagePart }) {
  switch (part.kind) {
    case 'text':
      return (
        <div className="markdown text-sm leading-6 break-words select-text">
          <Markdown remarkPlugins={[remarkGfm]}>{part.text}</Markdown>
        </div>
      )
    case 'quote':
      return (
        <details className="rounded-md border border-line/70 bg-surface/60 px-2.5 py-1.5 text-xs">
          <summary className="cursor-pointer font-mono text-ink-muted select-none">{part.title}</summary>
          <pre className="mt-1.5 overflow-x-auto font-mono text-[11px] leading-4 whitespace-pre-wrap text-ink-muted select-text">
            {part.body}
          </pre>
        </details>
      )
    case 'file':
      return <div className="font-mono text-xs text-accent">📎 {part.path.split('/').at(-1)}</div>
  }
}

function MessageRow({ message }: { message: StoredMessage }) {
  const mine = message.out
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[78%] rounded-xl px-3.5 py-2.5 ${
          mine ? 'bg-accent/12 border border-accent/20' : 'border border-line bg-raised'
        }`}
      >
        <div className="mb-1 flex items-baseline gap-2 text-[11px] text-ink-muted">
          <span className="font-medium">{mine ? 'Susie' : (message.sender ?? '?')}</span>
          <span>{formatTime(message.timestamp)}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {message.parts.map((part, index) => (
            <PartView key={index} part={part} />
          ))}
        </div>
      </div>
    </div>
  )
}

export function HistoryPage() {
  const intl = useIntl()
  const [chats, setChats] = useState<ChatInfo[]>([])
  const [selected, setSelected] = useState<{ channelId: string; chatId: string } | null>(null)
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<StoredMessage[] | null>(null)
  const [draft, setDraft] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const selectedRef = useRef(selected)
  selectedRef.current = selected

  const refreshChats = useCallback(() => {
    void ipc.history.chats().then(setChats)
  }, [])

  useEffect(() => {
    refreshChats()
    const off = onIpcEvent('history.message', (message) => {
      refreshChats()
      const current = selectedRef.current
      if (current !== null && current.channelId === message.channelId && current.chatId === message.chatId) {
        setMessages((prev) => [...prev, message])
      }
    })
    return off
  }, [refreshChats])

  useEffect(() => {
    if (selected === null) return
    void ipc.history.messages({ channelId: selected.channelId, chatId: selected.chatId, limit: 120 }).then(setMessages)
  }, [selected])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const runSearch = async () => {
    if (query.trim() === '') {
      setSearchResults(null)
      return
    }
    setSearchResults(await ipc.history.search({ q: query.trim() }))
  }

  const send = async () => {
    if (selected === null || draft.trim() === '') return
    setSendError(null)
    const result = await ipc.chat.send({
      channelId: selected.channelId,
      chatId: selected.chatId,
      text: draft,
    })
    if (!result.ok) {
      setSendError(result.message)
      return
    }
    setDraft('')
  }

  return (
    <div className="flex h-full gap-4">
      <aside className="flex w-64 shrink-0 flex-col gap-2">
        <div className="flex gap-1.5">
          <TextInput
            placeholder={intl.formatMessage({ id: 'history.search.placeholder' })}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void runSearch()
            }}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {chats.length === 0 && (
            <p className="px-1 py-4 text-xs text-ink-muted">{intl.formatMessage({ id: 'history.empty' })}</p>
          )}
          <div className="flex flex-col gap-1">
            {chats.map((chat) => {
              const active = selected?.channelId === chat.channelId && selected.chatId === chat.chatId
              return (
                <button
                  key={chatKey(chat.channelId, chat.chatId)}
                  onClick={() => {
                    setSearchResults(null)
                    setSelected({ channelId: chat.channelId, chatId: chat.chatId })
                  }}
                  className={`rounded-lg px-3 py-2 text-left transition-colors ${
                    active ? 'bg-raised shadow-sm' : 'hover:bg-raised/60'
                  }`}
                >
                  <div className="truncate text-sm font-medium">{chat.name ?? chat.chatId}</div>
                  <div className="truncate font-mono text-[11px] text-ink-muted">
                    {chat.channelId} · {chat.chatId}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-line bg-surface">
        {searchResults !== null ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs text-ink-muted">
                {intl.formatMessage({ id: 'history.search.results' }, { count: String(searchResults.length) })}
              </span>
              <Button onClick={() => setSearchResults(null)}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
            </div>
            <div className="flex flex-col gap-2">
              {searchResults.map((message) => (
                <MessageRow key={message.rowid} message={message} />
              ))}
            </div>
          </div>
        ) : selected === null ? (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-muted">
            {intl.formatMessage({ id: 'history.pick' })}
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <div className="flex flex-col gap-2.5">
                {messages.map((message) => (
                  <MessageRow key={message.rowid} message={message} />
                ))}
                <div ref={bottomRef} />
              </div>
            </div>
            <div className="border-t border-line p-3">
              {sendError !== null && <p className="mb-2 text-xs text-red-500">{sendError}</p>}
              <div className="flex gap-2">
                <TextInput
                  placeholder={intl.formatMessage({ id: 'history.composer.placeholder' })}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) void send()
                  }}
                />
                <Button variant="primary" disabled={draft.trim() === ''} onClick={() => void send()}>
                  {intl.formatMessage({ id: 'history.composer.send' })}
                </Button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  )
}
