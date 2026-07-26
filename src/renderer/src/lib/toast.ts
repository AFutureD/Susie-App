import { atom, getDefaultStore, useAtomValue } from 'jotai'
import { createElement } from 'react'

// 轻量 toast（无依赖）：取代散落的 window.alert。命令式 toast() 可在任何模块调用
// （经 jotai default store 驱动），ToastHost 挂在 app 根部渲染。

export interface ToastItem {
  id: number
  message: string
  kind: 'info' | 'error'
}

const TOAST_TTL_MS = 4000

export const toastsAtom = atom<ToastItem[]>([])

let seq = 0

export function toast(message: string, kind: ToastItem['kind'] = 'info'): void {
  const store = getDefaultStore()
  seq += 1
  const item: ToastItem = { id: seq, message, kind }
  store.set(toastsAtom, (prev) => [...prev, item])
  setTimeout(() => {
    store.set(toastsAtom, (prev) => prev.filter((existing) => existing.id !== item.id))
  }, TOAST_TTL_MS)
}

export function ToastHost() {
  const toasts = useAtomValue(toastsAtom)
  if (toasts.length === 0) return null
  return createElement(
    'div',
    { className: 'pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2' },
    toasts.map((item) =>
      createElement(
        'div',
        {
          key: item.id,
          className: `pointer-events-auto max-w-md rounded-lg border px-4 py-2.5 text-sm shadow-lg ${
            item.kind === 'error' ? 'border-red-500/30 bg-red-500/10 text-red-500' : 'border-line bg-raised text-ink'
          }`,
        },
        item.message,
      ),
    ),
  )
}
