import { useState } from 'react'
import { useIntl } from 'react-intl'
import type { BotIdentity } from '../../../../shared/messages'
import privacyDemoVideo from '../../assets/group-privacy-mode.mp4'
import { ipc } from '../../lib/ipc'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { groupPrivacyStatus } from './model'

/**
 * 群会话详情里的 Privacy Mode 状态：
 * - 开启（can_read_all_group_messages=false）→ amber 警告 + 教程视频弹窗 + 「重新检测」；
 * - 关闭 → 一行正向状态；未知 → 不渲染。
 * 重新检测的成功路径不需要本地处理：channels.identities 事件回流 → identity prop 更新 → 警告自动翻转。
 */
export function GroupPrivacyNotice({
  channelId,
  chatType,
  identity,
}: {
  channelId: string
  chatType: string | null
  identity: BotIdentity | undefined
}) {
  const intl = useIntl()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [videoOpen, setVideoOpen] = useState(false)

  const status = groupPrivacyStatus(chatType, identity)
  if (status === null || status === 'unknown') return null

  if (status === 'ok') {
    return (
      <p className="text-xs text-ink-muted/70">{intl.formatMessage({ id: 'bindings.detail.group.privacyMode.ok' })}</p>
    )
  }

  const recheck = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await ipc.channels.refreshIdentity({ id: channelId })
    if (!result.ok) setError(result.message)
    setBusy(false)
  }

  return (
    <Alert>
      <AlertTitle>{intl.formatMessage({ id: 'bindings.detail.group.privacyMode.warn.title' })}</AlertTitle>
      <AlertDescription>{intl.formatMessage({ id: 'bindings.detail.group.privacyMode.warn.body' })}</AlertDescription>
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={() => setVideoOpen(true)}>
          {intl.formatMessage({ id: 'bindings.detail.group.privacyMode.watchVideo' })}
        </Button>
        <Button disabled={busy} onClick={() => void recheck()}>
          {intl.formatMessage({ id: 'bindings.detail.group.privacyMode.recheck' })}
        </Button>
      </div>
      {error !== null && (
        <p className="mt-1 text-red-500">
          {intl.formatMessage({ id: 'bindings.detail.group.privacyMode.recheckFailed' }, { message: error })}
        </p>
      )}
      {videoOpen && (
        <Dialog open onOpenChange={setVideoOpen}>
          <DialogContent className="sm:max-w-80">
            <DialogHeader>
              <DialogTitle>{intl.formatMessage({ id: 'bindings.detail.group.privacyMode.video.title' })}</DialogTitle>
            </DialogHeader>
            <video
              src={privacyDemoVideo}
              className="w-full rounded-lg border border-line"
              autoPlay
              loop
              muted
              playsInline
              controls
            />
          </DialogContent>
        </Dialog>
      )}
    </Alert>
  )
}
