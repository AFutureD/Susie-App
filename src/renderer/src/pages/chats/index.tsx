import { useIntl } from 'react-intl'
import { useAtomValue } from 'jotai'
import { Link } from 'react-router'
import { BindingsPanel } from '../../components/bindings-panel/bindings-panel'
import { Button } from '@/components/ui/button'
import { Page } from '../../components/page'
import { configStateAtom } from '../../lib/config-atoms'

// 「会话」模块主页面：会话绑定管理（渠道 → 会话 → 助手/是否响应）；会话历史是二级页面。

export function ChatsPage() {
  const intl = useIntl()
  const state = useAtomValue(configStateAtom)

  if (!state) {
    return <Page titleId="page.chats.title">{intl.formatMessage({ id: 'common.loading' })}</Page>
  }

  return (
    <Page
      titleId="page.chats.title"
      actions={
        <Button variant="outline" render={<Link to="/chats/history" />}>
          {intl.formatMessage({ id: 'chats.history.open' })}
        </Button>
      }
    >
      <p className="mb-4 text-xs text-ink-muted">{intl.formatMessage({ id: 'bindings.hint' })}</p>
      <BindingsPanel state={state} />
    </Page>
  )
}
