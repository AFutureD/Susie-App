import type { BotIdentity } from '../../shared/messages'
import { errorMessage } from '../../shared/errors'
import type { ConfigStore, Unsubscribe } from '../config/store'
import type { Logger } from '../util/logger'
import { getMeRaw, tgDisplayName } from './telegram/bot-api'

export interface BotIdentityRegistryDeps {
  store: ConfigStore
  /** 快照有变化即全量推送（channels.identities 事件） */
  emit: (identities: BotIdentity[]) => void
  log: Logger
}

/** 拉取失败的重试间隔（启动时离线等场景，直到成功或渠道被删） */
const RETRY_MS = 60_000

interface CacheEntry {
  token: string
  identity: BotIdentity | null
  retryTimer: NodeJS.Timeout | null
}

/**
 * 渠道 bot 身份缓存（display name + username）：应用启动对 channels ∪ manager_bots
 * 的 token 逐一 getMe，配置变更增量刷新（新增/换 token 拉取，删除清缓存）。
 * 只服务 UI 展示——通道运行完全不依赖本缓存，失败仅回退显示渠道 id。
 */
export class BotIdentityRegistry {
  private readonly deps: BotIdentityRegistryDeps
  private readonly cache = new Map<string, CacheEntry>()
  private readonly unsubscribes: Unsubscribe[] = []
  private readonly abort = new AbortController()
  private stopped = false

  constructor(deps: BotIdentityRegistryDeps) {
    this.deps = deps
  }

  start(): void {
    this.reconcile()
    this.unsubscribes.push(
      this.deps.store.subscribePath('channels', () => this.reconcile()),
      this.deps.store.subscribePath('manager_bots', () => this.reconcile()),
    )
  }

  stop(): void {
    this.stopped = true
    for (const unsubscribe of this.unsubscribes) unsubscribe()
    this.unsubscribes.length = 0
    this.abort.abort()
    for (const entry of this.cache.values()) {
      if (entry.retryTimer !== null) clearTimeout(entry.retryTimer)
    }
    this.cache.clear()
  }

  identities(): BotIdentity[] {
    const result: BotIdentity[] = []
    for (const entry of this.cache.values()) {
      if (entry.identity !== null) result.push(entry.identity)
    }
    return result
  }

  private reconcile(): void {
    if (this.stopped) return
    const config = this.deps.store.current
    // 同 id 撞名时渠道优先（channels 与 manager_bots 分属不同命名空间，正常不重叠）
    const wanted = new Map<string, string>()
    for (const [id, settings] of Object.entries(config.manager_bots)) wanted.set(id, settings.token)
    for (const [id, settings] of Object.entries(config.channels)) {
      if (settings.type === 'telegram_bot') wanted.set(id, settings.token)
    }

    let changed = false
    for (const [id, entry] of this.cache) {
      if (wanted.get(id) !== entry.token) {
        if (entry.retryTimer !== null) clearTimeout(entry.retryTimer)
        this.cache.delete(id)
        if (entry.identity !== null) changed = true
      }
    }
    for (const [id, token] of wanted) {
      if (this.cache.has(id)) continue
      const entry: CacheEntry = { token, identity: null, retryTimer: null }
      this.cache.set(id, entry)
      void this.fetch(id, entry)
    }
    if (changed) this.deps.emit(this.identities())
  }

  /** 手动重拉（UI「重新检测」）：清掉在途重试，立即 getMe 一次并返回结果。
   * 失败时已有旧 identity 则保留（UI 不闪退回渠道 id）；从未成功过则恢复自动重试。 */
  async refresh(channelId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const entry = this.cache.get(channelId)
    if (entry === undefined) return { ok: false, message: `渠道 ${channelId} 不存在` }
    if (entry.retryTimer !== null) {
      clearTimeout(entry.retryTimer)
      entry.retryTimer = null
    }
    const result = await this.fetchOnce(channelId, entry)
    if (!result.ok && entry.identity === null && !this.stopped && this.cache.get(channelId) === entry) {
      this.scheduleRetry(channelId, entry)
    }
    return result
  }

  /** 自动路径：失败 60s 重试直到成功或渠道被删 */
  private async fetch(id: string, entry: CacheEntry): Promise<void> {
    const result = await this.fetchOnce(id, entry)
    if (result.ok) return
    if (this.stopped || this.cache.get(id) !== entry) return
    this.deps.log.info(`channel ${id}: getMe 身份拉取失败（${RETRY_MS / 1000}s 后重试）：${result.message}`)
    this.scheduleRetry(id, entry)
  }

  /** 单次 getMe：成功写缓存并广播；失败只返回错误，重试策略由调用方决定 */
  private async fetchOnce(id: string, entry: CacheEntry): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const me = await getMeRaw(entry.token, this.abort.signal)
      // 等待期间渠道被删/换 token（reconcile 已换入新 entry）→ 丢弃过期结果
      if (this.stopped || this.cache.get(id) !== entry) return { ok: true }
      entry.identity = {
        channelId: id,
        name: tgDisplayName(me) ?? id,
        username: me.username ?? null,
        canReadAllGroupMessages: me.can_read_all_group_messages ?? null,
      }
      this.deps.emit(this.identities())
      return { ok: true }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  private scheduleRetry(id: string, entry: CacheEntry): void {
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null
      void this.fetch(id, entry)
    }, RETRY_MS)
  }
}
