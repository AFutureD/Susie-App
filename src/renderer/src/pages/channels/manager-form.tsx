import { useState } from 'react'
import { useIntl } from 'react-intl'
import type { ConfigState, ManagerBotConfig } from '../../../../shared/config'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ipc } from '../../lib/ipc'

// Manager bot 的行内编辑（新增走统一的 AddBotForm，凭 can_manage_bots 自动落到这一类）：
// 只有 token——无 enabled（存在即运行）、无 drop_pending（离线积压的创建事件必须收）。
// managing 列表由添加流程维护，表单不暴露。

export function ManagerBotForm({
  managerId,
  initial,
  state,
  onDone,
}: {
  managerId: string
  initial: ManagerBotConfig
  state: ConfigState
  onDone: () => void
}) {
  const intl = useIntl()
  const [token, setToken] = useState(initial.token)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)
    const result = await ipc.config.upsertManagerBot({
      id: managerId,
      settings: { token: token.trim(), managing: initial.managing },
      expectedVersion: state.version,
    })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onDone()
  }

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
      <div className="grid grid-cols-2 gap-3">
        <Field>
          <FieldLabel htmlFor={`manager-${managerId}-id`}>{intl.formatMessage({ id: 'channels.field.id' })}</FieldLabel>
          <Input id={`manager-${managerId}-id`} value={managerId} disabled />
        </Field>
        <Field>
          <FieldLabel htmlFor={`manager-${managerId}-token`}>
            {intl.formatMessage({ id: 'channels.field.token' })}
          </FieldLabel>
          <Input
            id={`manager-${managerId}-token`}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="123456:bot-token"
          />
        </Field>
      </div>

      <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'managerBots.hint' })}</p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button disabled={busy || token.trim() === ''} onClick={() => void submit()}>
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        <Button variant="outline" onClick={onDone}>
          {intl.formatMessage({ id: 'common.cancel' })}
        </Button>
      </div>
    </div>
  )
}
