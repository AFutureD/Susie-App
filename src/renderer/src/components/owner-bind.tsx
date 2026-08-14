import { useEffect, useState } from 'react'
import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import type { ConfigState } from '../../../shared/config'
import type { SenderInfo } from '../../../shared/messages'
import { transferOwner } from '../../../shared/users'
import { channelStatusesAtom, managerStatusesAtom } from '../lib/service-atoms'
import { ipc } from '../lib/ipc'
import { tgResolveLink } from '../lib/telegram'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyDescription } from '@/components/ui/empty'
import { useSenders } from './member-picker'

// Owner 绑定件：监听频道的私聊发送者（实时），选中即设为 owner。
// onboarding 第 2 步与「频道新增后」的弹窗共用；仅列私聊发送者——owner 必须私聊过 bot，审核卡片才能送达。

export function OwnerBindPanel({
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
  const senders = useSenders(channelId, undefined, { privateOnly: true })
  const statuses = useAtomValue(channelStatusesAtom)
  const managerStatuses = useAtomValue(managerStatusesAtom)
  // channelId 也可能是 manager id（manager 私聊同样 record-only 入历史，绑定流程完全复用）
  const status = [...statuses, ...managerStatuses].find((item) => item.id === channelId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bindOwner = async (sender: SenderInfo): Promise<void> => {
    if (busy) return
    setBusy(true)
    const users = transferOwner(state.config.users, channelId, sender.id, sender.name ?? undefined)
    const result = await ipc.config.setUsers({ users, expectedVersion: state.version })
    setBusy(false)
    if (!result.ok) {
      setError(result.conflict ? intl.formatMessage({ id: 'bindings.error.conflictRefreshed' }) : result.message)
      return
    }
    onBound()
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm leading-6 text-ink-muted">{intl.formatMessage({ id: 'ownerBind.hint' })}</p>
        <div className="mt-3 flex items-center gap-3">
          <Button
            disabled={botUsername === null}
            onClick={() => void ipc.app.openExternal({ url: tgResolveLink(botUsername ?? '') })}
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

      <div className="rounded-lg border border-line">
        {senders.length === 0 ? (
          <Empty>
            <EmptyDescription>{intl.formatMessage({ id: 'ownerBind.waiting' })}</EmptyDescription>
          </Empty>
        ) : (
          <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto p-2">
            {senders.map((sender) => (
              <div key={sender.id} className="flex items-center gap-3 rounded-md px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate text-sm">{sender.name ?? sender.id}</span>
                <Button variant="outline" disabled={busy} onClick={() => void bindOwner(sender)}>
                  {intl.formatMessage({ id: 'ownerBind.bind' })}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/** 频道新增后的 owner 绑定弹窗；可关闭（之后在「用户」页设置） */
export function OwnerBindModal({
  state,
  channelId,
  onClose,
}: {
  state: ConfigState
  channelId: string
  onClose: () => void
}) {
  const intl = useIntl()
  const [botUsername, setBotUsername] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)

  // manager bot 不在 channels：token 从 manager_bots 兜底（owner 绑定弹窗两者共用）
  const token = state.config.channels[channelId]?.token ?? state.config.manager_bots[channelId]?.token

  useEffect(() => {
    if (botUsername !== null || token === undefined) return
    let alive = true
    void ipc.channels.resolveUsername({ token }).then((result) => {
      if (!alive) return
      if (result.ok) setBotUsername(result.username)
      else setLinkError(result.message)
    })
    return () => {
      alive = false
    }
  }, [botUsername, token])

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-[28rem]">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: 'ownerBind.title' })}</DialogTitle>
          <DialogDescription>{intl.formatMessage({ id: 'ownerBind.subtitle' })}</DialogDescription>
        </DialogHeader>
        <OwnerBindPanel
          state={state}
          channelId={channelId}
          botUsername={botUsername}
          linkError={linkError}
          onBound={onClose}
        />
        <Button variant="link" className="justify-self-start" onClick={onClose}>
          {intl.formatMessage({ id: 'ownerBind.later' })}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
