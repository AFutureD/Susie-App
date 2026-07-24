import { atom } from 'jotai'
import type { UpdateState } from '../../../shared/messages'

/** 主进程 updater 状态镜像：update:get-state 初始化，update:state 事件保持同步 */
export const updateStateAtom = atom<UpdateState>({ status: 'idle' })
