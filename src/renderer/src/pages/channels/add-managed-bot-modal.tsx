import { useIntl } from 'react-intl'
import type { ConfigState } from '../../../../shared/config'
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-[26rem] flex-col gap-4 overflow-y-auto rounded-xl border border-line bg-raised p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div>
          <h3 className="text-base font-semibold">{intl.formatMessage({ id: 'managedBot.title' })}</h3>
          <p className="mt-1 text-xs leading-5 text-ink-muted">{intl.formatMessage({ id: 'managedBot.subtitle' })}</p>
        </div>

        <ManagedBotCreatePanel state={state} managerId={managerId} onAdded={(channelId) => onAdded(channelId)} />

        <button
          type="button"
          onClick={onClose}
          className="self-start text-xs text-ink-muted underline-offset-2 hover:underline"
        >
          {intl.formatMessage({ id: 'managedBot.manualFallback' })}
        </button>
      </div>
    </div>
  )
}
