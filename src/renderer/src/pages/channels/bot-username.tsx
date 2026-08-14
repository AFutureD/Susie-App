import { useEffect, useRef, useState } from 'react'
import { useIntl } from 'react-intl'
import { ExternalLinkIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ipc } from '../../lib/ipc'
import { tgResolveLink } from '../../lib/telegram'

/** @username 点击复制，尾随跳转 icon 经 tg:// 打开与 bot 的对话。 */
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
    <span className="flex min-w-0 items-center gap-1 font-mono text-xs text-ink-muted/70">
      <Button
        variant="link"
        title={intl.formatMessage({ id: 'channels.username.copy' })}
        onClick={() => void copy()}
        className="h-auto min-w-0 truncate p-0 text-xs font-normal text-ink-muted/70 hover:text-ink-muted hover:no-underline"
      >
        @{username}
      </Button>
      {copied && (
        <span className="shrink-0 text-emerald-500">✓ {intl.formatMessage({ id: 'channels.username.copied' })}</span>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        title={intl.formatMessage({ id: 'channels.username.open' })}
        aria-label={intl.formatMessage({ id: 'channels.username.open' })}
        onClick={() => void ipc.app.openExternal({ url: tgResolveLink(username) })}
        className="shrink-0 text-ink-muted/60 hover:text-ink-muted"
      >
        <ExternalLinkIcon />
      </Button>
    </span>
  )
}
