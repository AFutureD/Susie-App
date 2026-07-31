import { useEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'
import { ipc } from '../../lib/ipc'
import { tgResolveLink } from '../../lib/telegram'

/** 渠道行副标题：@username 点击复制，尾随跳转 icon 经 tg:// 打开与 bot 的对话 */
export function BotUsername({ username }: { username: string }) {
  const intl = useIntl()
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    },
    [],
  )

  const copy = async () => {
    await navigator.clipboard.writeText(username)
    setCopied(true)
    if (resetTimer.current !== null) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <span className="flex min-w-0 items-center gap-1 font-mono text-xs text-ink-muted">
      <button
        type="button"
        title={intl.formatMessage({ id: 'channels.username.copy' })}
        onClick={() => void copy()}
        className="truncate transition-colors hover:text-ink"
      >
        @{username}
      </button>
      {copied && (
        <span className="shrink-0 text-emerald-500">✓ {intl.formatMessage({ id: 'channels.username.copied' })}</span>
      )}
      <button
        type="button"
        title={intl.formatMessage({ id: 'channels.username.open' })}
        aria-label={intl.formatMessage({ id: 'channels.username.open' })}
        onClick={() => void ipc.app.openExternal({ url: tgResolveLink(username) })}
        className="shrink-0 rounded p-0.5 transition-colors hover:bg-line/50 hover:text-ink"
      >
        <svg
          viewBox="0 0 12 12"
          className="size-3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3.5 8.5 8.5 3.5M4.75 3.5H8.5v3.75" />
        </svg>
      </button>
    </span>
  )
}
