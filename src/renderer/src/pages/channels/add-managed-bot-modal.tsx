import { useIntl } from 'react-intl'
import type { ConfigState } from '../../../../shared/config'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ManagedBotCreatePanel } from '../../components/managed-bot-create'

// 「添加托管 Bot」弹窗：面板逻辑在 components/managed-bot-create.tsx（与 onboarding 共用），
// 这里只包弹窗壳；点「添加」落地为渠道后经 onAdded 通知页面层（接「绑定默认助手」弹窗）。

export function AddManagedBotModal({
  state,
  managerId,
  onClose,
  onAdded,
}: {
  state: ConfigState
  managerId: string
  onClose: () => void
  /** 托管 Bot 落地为渠道后回调（channelId = bot username）；页面层据此接后续弹窗 */
  onAdded: (channelId: string) => void
}) {
  const intl = useIntl()

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[26rem]">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: 'managedBot.title' })}</DialogTitle>
          <DialogDescription>{intl.formatMessage({ id: 'managedBot.subtitle' })}</DialogDescription>
        </DialogHeader>

        <ManagedBotCreatePanel state={state} managerId={managerId} onAdded={(channelId) => onAdded(channelId)} />

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {intl.formatMessage({ id: 'managedBot.manualFallback' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
