import { useState } from 'react'
import { useIntl } from 'react-intl'
import type { ConfigState } from '../../../../shared/config'
import { Button, ErrorText, Field, TextInput } from '../../components/form'
import { ipc } from '../../lib/ipc'

// 统一新增入口：粘贴 token → getMe 自动识别类型——can_manage_bots 的 bot 作为
// 渠道管理（manager_bots）接入，其余作为普通 telegram_bot 渠道。用户不手选类型；
// drop_pending 等运行参数属于编辑态，新增只管接入。

export function AddBotForm({
  state,
  onDone,
  onCreated,
}: {
  state: ConfigState
  onDone: () => void
  /** 新建成功回调（进入 owner 绑定） */
  onCreated: (id: string) => void
}) {
  const intl = useIntl()
  const [id, setId] = useState('')
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setError(null)

    const probe = await ipc.channels.resolveUsername({ token: token.trim() })
    if (!probe.ok) {
      setBusy(false)
      setError(intl.formatMessage({ id: 'channels.resolve.failed' }, { detail: probe.message }))
      return
    }

    const finalId = id.trim() === '' ? probe.username : id.trim()
    if (finalId in state.config.channels || finalId in state.config.manager_bots) {
      setBusy(false)
      setError(intl.formatMessage({ id: 'channels.duplicate' }, { id: finalId }))
      return
    }

    const result = probe.canManageBots
      ? await ipc.config.upsertManagerBot({
          id: finalId,
          settings: { token: token.trim(), managing: [] },
          expectedVersion: state.version,
        })
      : await ipc.config.upsertChannel({
          id: finalId,
          settings: { type: 'telegram_bot', token: token.trim(), enabled: true, drop_pending_updates: false },
          expectedVersion: state.version,
        })
    setBusy(false)
    if (!result.ok) {
      setError(result.message)
      return
    }
    onDone()
    onCreated(finalId)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={intl.formatMessage({ id: 'channels.field.id' })}
          hint={intl.formatMessage({ id: 'channels.field.id.hint' })}
        >
          <TextInput value={id} onChange={(event) => setId(event.target.value)} placeholder="my_bot" />
        </Field>
        <Field label={intl.formatMessage({ id: 'channels.field.token' })}>
          <TextInput value={token} onChange={(event) => setToken(event.target.value)} placeholder="123456:bot-token" />
        </Field>
      </div>

      <p className="text-xs text-ink-muted">{intl.formatMessage({ id: 'channels.addForm.hint' })}</p>
      <ErrorText message={error} />
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || token.trim() === ''} onClick={() => void submit()}>
          {intl.formatMessage({ id: 'common.save' })}
        </Button>
        <Button onClick={onDone}>{intl.formatMessage({ id: 'common.cancel' })}</Button>
      </div>
    </div>
  )
}
