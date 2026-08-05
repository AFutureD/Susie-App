import { useCallback, useState } from 'react'
import { useIntl } from 'react-intl'
import { canonicalizeBindings, expandBindings, type BindingAssignments } from '../../../../shared/bindings'
import type { ConfigState } from '../../../../shared/config'
import { ipc } from '../../lib/ipc'

// bindings 的全量替换写（expand → mutate → canonicalize → setBindings）+ busy/error。
// 绑定面板、「绑定默认助手」弹窗与 onboarding 绑定步共用，避免三处各写一份提交逻辑。
export function useBindingsWriter(state: ConfigState) {
  const intl = useIntl()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = useCallback(
    async (mutate: (assignments: BindingAssignments) => void): Promise<boolean> => {
      if (busy) return false
      setBusy(true)
      const assignments = expandBindings(state.config.bindings)
      mutate(assignments)
      const result = await ipc.config.setBindings({
        bindings: canonicalizeBindings(assignments),
        expectedVersion: state.version,
      })
      setBusy(false)
      if (!result.ok) {
        setError(result.conflict ? intl.formatMessage({ id: 'bindings.error.conflictRefreshed' }) : result.message)
        return false
      }
      setError(null)
      return true
    },
    [busy, state.config.bindings, state.version, intl],
  )

  return { busy, error, submit }
}
