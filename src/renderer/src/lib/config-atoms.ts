import { atom, type Atom } from 'jotai'
import { selectAtom } from 'jotai/utils'
import type { Config, ConfigState } from '../../../shared/config'
import { deepEqual } from '../../../shared/equal'

/** 主进程 ConfigStore 的镜像：config.get 初始化，config.state 事件保持同步 */
export const configStateAtom = atom<ConfigState | null>(null)

/** 乐观并发版本号（useConfigMutation 经 default store 现取，无需组件订阅整包） */
export const configVersionAtom = selectAtom(configStateAtom, (state) => state?.version ?? 0)

const sliceAtoms = new Map<keyof Config, Atom<unknown>>()

/**
 * 按顶层 key 的配置切片 atom（deepEqual 去抖）：bindings 变更不再重渲只关心 channels 的组件。
 * 只做 5 个顶层 key，不做深层 path——组件内 useMemo 取子项即可。
 */
export function configAtom<K extends keyof Config>(key: K): Atom<Config[K] | null> {
  let sliced = sliceAtoms.get(key)
  if (sliced === undefined) {
    sliced = selectAtom(configStateAtom, (state) => state?.config[key] ?? null, deepEqual)
    sliceAtoms.set(key, sliced)
  }
  return sliced as Atom<Config[K] | null>
}
