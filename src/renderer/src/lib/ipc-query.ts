import { useCallback, useEffect, useMemo } from 'react'
import { useSyncExternalStore } from 'react'
import type { IpcEvents } from '../../../shared/ipc/events'
import { errorMessage } from '../../../shared/errors'
import { onIpcEvent } from './ipc'

// IPC 查询缓存：按 key 共享请求结果 + in-flight 去重 + 事件驱动失效。
// 每个事件通道只建一条共享 bridge 订阅（懒建，模块生命周期）——同一事件触发的多个查询
// 合并为一次去重 refetch，取代「N 个组件各自订阅 history.message 再各自全量重查」。

export interface QuerySnapshot<T> {
  data: T | null
  loading: boolean
  error: string | null
}

interface Entry {
  key: string
  fetcher: () => Promise<unknown>
  invalidateOn: ReadonlySet<keyof IpcEvents>
  snapshot: QuerySnapshot<unknown>
  inflight: Promise<void> | null
  listeners: Set<() => void>
}

const entries = new Map<string, Entry>()
const eventSubscriptions = new Set<keyof IpcEvents>()

function notify(entry: Entry): void {
  for (const listener of entry.listeners) listener()
}

function refetch(entry: Entry): Promise<void> {
  // in-flight 合并：事件风暴（history.message 连发）天然只触发一次在途请求
  if (entry.inflight !== null) return entry.inflight
  entry.snapshot = { ...entry.snapshot, loading: true }
  notify(entry)
  const run = entry
    .fetcher()
    .then((data) => {
      entry.snapshot = { data, loading: false, error: null }
    })
    .catch((error: unknown) => {
      entry.snapshot = { ...entry.snapshot, loading: false, error: errorMessage(error) }
    })
    .finally(() => {
      entry.inflight = null
      notify(entry)
    })
  entry.inflight = run
  return run
}

function ensureEventSubscription(event: keyof IpcEvents): void {
  if (eventSubscriptions.has(event)) return
  eventSubscriptions.add(event)
  onIpcEvent(event, () => {
    for (const entry of entries.values()) {
      if (entry.invalidateOn.has(event)) void refetch(entry)
    }
  })
}

function ensureEntry(key: string, fetcher: () => Promise<unknown>, invalidateOn: readonly (keyof IpcEvents)[]): Entry {
  let entry = entries.get(key)
  if (entry === undefined) {
    entry = {
      key,
      fetcher,
      invalidateOn: new Set(invalidateOn),
      snapshot: { data: null, loading: true, error: null },
      inflight: null,
      listeners: new Set(),
    }
    entries.set(key, entry)
    for (const event of invalidateOn) ensureEventSubscription(event)
    void refetch(entry)
  } else {
    // 同 key 复用缓存；fetcher 以最新闭包为准（参数已编码进 key，行为等价）
    entry.fetcher = fetcher
  }
  return entry
}

const DISABLED_SNAPSHOT: QuerySnapshot<unknown> = { data: null, loading: false, error: null }

/**
 * 查询 hook：`useIpcQuery('history.chats', () => ipc.history.chats(), { invalidateOn: ['history.message'] })`。
 * key 必须编码全部请求参数（同 key = 同缓存条目）；enabled=false 时不发起请求。
 */
export function useIpcQuery<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: { invalidateOn?: readonly (keyof IpcEvents)[]; enabled?: boolean } = {},
): QuerySnapshot<T> & { refetch: () => void } {
  const enabled = options.enabled !== false
  const invalidateOn = options.invalidateOn ?? []

  const entry = enabled ? ensureEntry(key, fetcher as () => Promise<unknown>, invalidateOn) : null

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (entry === null) return () => {}
      entry.listeners.add(onStoreChange)
      return () => {
        entry.listeners.delete(onStoreChange)
      }
    },
    [entry],
  )
  const snapshot = useSyncExternalStore(subscribe, () => entry?.snapshot ?? DISABLED_SNAPSHOT)

  // enabled 从 false 变 true 时 ensureEntry 已在渲染期发起首查；此 effect 只兜住 key 切换后的复用条目过期
  useEffect(() => {
    if (entry !== null && entry.snapshot.data === null && entry.inflight === null && entry.snapshot.error === null) {
      void refetch(entry)
    }
  }, [entry])

  return {
    ...(snapshot as QuerySnapshot<T>),
    refetch: () => {
      if (entry !== null) void refetch(entry)
    },
  }
}

/** 测试钩子：清空缓存（模块级状态在 vitest 各文件间隔离，但同文件用例间需要复位） */
export function resetIpcQueryCacheForTests(): void {
  entries.clear()
  eventSubscriptions.clear()
}

// ---------- 常用查询 ----------

import type { BotIdentity, ChatInfo } from '../../../shared/messages'
import { ipc } from './ipc'

/** 全部历史会话（history.message 事件自动失效；所有页面共享同一缓存条目与订阅） */
export function useChatsQuery(): QuerySnapshot<ChatInfo[]> & { refetch: () => void } {
  return useIpcQuery('history.chats', () => ipc.history.chats(), { invalidateOn: ['history.message'] })
}

/** 渠道/manager bot 的 getMe 身份快照（channels.identities 事件自动失效） */
export function useBotIdentitiesQuery(): QuerySnapshot<BotIdentity[]> & { refetch: () => void } {
  return useIpcQuery('channels.identities', () => ipc.channels.identities(), {
    invalidateOn: ['channels.identities'],
  })
}

/** channelId → 身份的查找表；未拉到身份的渠道不在表中（调用方回退渠道 id） */
export function useBotIdentityMap(): Map<string, BotIdentity> {
  const { data } = useBotIdentitiesQuery()
  return useMemo(() => new Map((data ?? []).map((identity) => [identity.channelId, identity])), [data])
}
