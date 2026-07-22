import { atom } from 'jotai'
import type { ConfigState } from '../../../shared/config'

/** 主进程 ConfigStore 的镜像：config:get 初始化，config:state 事件保持同步 */
export const configStateAtom = atom<ConfigState | null>(null)
