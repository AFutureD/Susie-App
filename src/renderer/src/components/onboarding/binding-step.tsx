import { useIntl } from 'react-intl'
import type { ConfigState } from '../../../../shared/config'
import { ChannelDefaultBindingPanel } from '../channel-default-binding'

// 向导绑定步：为刚建好的渠道选默认助手 + 是否响应（与渠道页新增后的弹窗同一面板）。
// 具体会话可稍后在「会话」页添加精确绑定。

export function BindingStep({
  state,
  channelId,
  onFinish,
}: {
  state: ConfigState
  channelId: string
  onFinish: () => void
}) {
  const intl = useIntl()
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{intl.formatMessage({ id: 'onboarding.step.binding' })}</h2>
        <p className="mt-1 text-xs text-ink-muted">{intl.formatMessage({ id: 'onboarding.binding.subtitle' })}</p>
      </div>
      <ChannelDefaultBindingPanel state={state} channelId={channelId} onDone={onFinish} />
    </section>
  )
}
