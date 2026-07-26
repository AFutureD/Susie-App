import { getDefaultStore } from 'jotai'
import { useCallback, useState } from 'react'
import type { ConfigMutationResult } from '../../../shared/config'
import { configStateAtom } from './config-atoms'
import { toast } from './toast'

// 配置写操作的统一封装：自动注入 expectedVersion（现取最新 config 版本），
// 失败/版本冲突统一 toast。需要内联展示错误的表单（频道/助手表单、Raw 编辑器）
// 保持自己的 result 处理，不经本 hook。

const CONFLICT_MESSAGE = '配置已被其他修改更新，请重试'

export function useConfigMutation() {
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (mutate: (expectedVersion: number) => Promise<ConfigMutationResult>): Promise<boolean> => {
      const state = getDefaultStore().get(configStateAtom)
      if (state === null) return false
      setBusy(true)
      try {
        const result = await mutate(state.version)
        if (!result.ok) {
          // 冲突时 config.state 事件已把最新版本推给 UI，重试即可
          toast(result.conflict ? CONFLICT_MESSAGE : result.message, 'error')
          return false
        }
        return true
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  return { run, busy }
}
