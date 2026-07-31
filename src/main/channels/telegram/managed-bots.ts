import type { Config, ConfigState, ManagerBotConfig } from '../../../shared/config'
import { errorMessage } from '../../../shared/errors'
import type { ChannelStatus, InboundEnvelope, ManagedBotDiscovery } from '../../../shared/messages'
import { channelOwner } from '../../../shared/users'
import type { ConfigStore, Unsubscribe } from '../../config/store'
import type { Logger } from '../../util/logger'
import { BotApiError, getManagedBotToken, tgDisplayName, type TgManagedBotUpdated } from './bot-api'
import type { DiscoveryRepo } from './discovery-repo'
import { TelegramManagerBotChannel, type ManagerBotTimings } from './manager-bot'
import type { Channel } from '../types'

// Manager bot 的编排中枢（service 级单例，poller 是随 token 编辑销毁重建的短命对象）：
// - 订阅 manager_bots 配置段，自管 poller 生命周期（存在即运行——无 enabled，删除即停）；
// - 收 managed_bot update：已添加渠道 → token 轮换写回 config（hub 因 restartRequired 自动重启）；
//   其余 → 登记发现并推事件。发现 ≠ 添加，绝不自动建渠道；
// - addManagedBot 是唯一建渠道入口（用户在弹窗显式触发）。

export type AddManagedBotResult =
  | { ok: true; channelId: string; state: ConfigState }
  | { ok: false; message: string; conflict: boolean }

export interface ManagedBotRegistryDeps {
  store: ConfigStore
  repo: DiscoveryRepo
  /** 某 manager 的发现列表变化（全量替换，UI 直接换） */
  emit: (managerId: string, discoveries: ManagedBotDiscovery[]) => void
  onMessage: (envelope: InboundEnvelope) => void
  onStatuses: (statuses: ChannelStatus[]) => void
  log: Logger
  /** 测试注入：缩短轮询重试间隔 */
  timings?: Partial<ManagerBotTimings>
}

export class ManagedBotRegistry {
  private readonly deps: ManagedBotRegistryDeps
  private readonly pollers = new Map<string, TelegramManagerBotChannel>()
  private readonly runningTokens = new Map<string, string>()
  /** 正在重启（token 变更 teardown 中）的 manager：补启动循环必须跳过，防双重 spawn */
  private readonly pendingRestarts = new Set<string>()
  private unsubscribe: Unsubscribe | null = null

  constructor(deps: ManagedBotRegistryDeps) {
    this.deps = deps
  }

  start(): void {
    this.reconcile(this.deps.store.current.manager_bots)
    this.unsubscribe = this.deps.store.subscribePath('manager_bots', (next) => {
      this.reconcile((next ?? {}) as Config['manager_bots'])
    })
  }

  /** service.getChannel 的 fallback：history 页 composer 给 manager 私聊发消息 */
  get(id: string): Channel | undefined {
    return this.pollers.get(id)
  }

  statuses(): ChannelStatus[] {
    const result: ChannelStatus[] = []
    for (const id of Object.keys(this.deps.store.current.manager_bots)) {
      const poller = this.pollers.get(id)
      result.push(poller !== undefined ? poller.status() : { id, state: 'stopped', detail: null })
    }
    return result
  }

  async stopAll(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    await Promise.all(Array.from(this.pollers.keys()).map((id) => this.teardown(id, { removed: false })))
  }

  // ---------- 发现与添加 ----------

  /**
   * 某 manager「未添加」的发现列表（记录添加后不删——对照当前 config 过滤掉已是渠道的，
   * 渠道删除后记录自然重新露出，凭此重新加回）。
   */
  list(managerId: string): ManagedBotDiscovery[] {
    return this.deps.repo.listByManager(managerId).filter((discovery) => this.findChannelByBotId(discovery.botId) === null)
  }

  /**
   * 弹窗打开时的列表：在 list 基础上对每条做一次 Telegram 侧存活校验——
   * BotFather 中已删除的 bot 取 token 会被拒（400/403），随手清库不再列出；
   * 网络/限流/manager token 失效（401 等）不当作已删除，保守保留。
   */
  async listAddable(managerId: string): Promise<ManagedBotDiscovery[]> {
    const candidates = this.list(managerId)
    const manager = this.deps.store.current.manager_bots[managerId]
    if (manager === undefined || candidates.length === 0) return candidates

    const checked = await Promise.all(
      candidates.map(async (discovery) => {
        try {
          await getManagedBotToken(manager.token, Number(discovery.botId))
          return discovery
        } catch (error) {
          if (error instanceof BotApiError && (error.code === 400 || error.code === 403)) {
            this.deps.log.info(
              `manager ${managerId}: 发现记录 @${discovery.username} 在 Telegram 侧已不可用（${error.message}），清除`,
            )
            this.deps.repo.delete(managerId, discovery.botId)
            return null
          }
          return discovery
        }
      }),
    )
    const alive = checked.filter((item) => item !== null)
    if (alive.length !== candidates.length) this.emitFor(managerId)
    return alive
  }

  /**
   * managed_bot update 入口（poller 回调；永不抛）。
   * 已添加渠道（token 前缀命中且在 managing 中）→ token 轮换；其余 → 登记发现。
   */
  async handleManagedBotUpdate(managerId: string, managerToken: string, ev: TgManagedBotUpdated): Promise<void> {
    try {
      const botId = String(ev.bot.id)
      const existingId = this.findChannelByBotId(botId)
      const manager = this.deps.store.current.manager_bots[managerId]

      if (existingId !== null && manager !== undefined && manager.managing.includes(existingId)) {
        await this.rotateTokenIfChanged(managerId, managerToken, existingId, ev.bot.id)
        return
      }

      this.deps.repo.upsert({
        managerId,
        botId,
        username: ev.bot.username ?? botId,
        name: tgDisplayName(ev.bot) ?? botId,
        creatorId: String(ev.user.id),
        creatorName: tgDisplayName(ev.user),
        discoveredTs: Date.now(),
      })
      this.emitFor(managerId)
    } catch (error) {
      this.deps.log.error(`manager ${managerId}: managed_bot 事件处理失败：${errorMessage(error)}`)
    }
  }

  /** 唯一的建渠道入口：取 token → 原子写入渠道 + managing + owner（manager 的 owner，创建者兜底） */
  async addManagedBot(input: { managerId: string; botId: string; expectedVersion: number }): Promise<AddManagedBotResult> {
    const { managerId, botId, expectedVersion } = input
    const store = this.deps.store

    const manager = store.current.manager_bots[managerId]
    if (manager === undefined) return fail(`manager 不存在：${managerId}`)

    const discovery = this.deps.repo.get(managerId, botId)
    if (discovery === null) return fail('发现记录不存在（可能已失效，请重新在 Telegram 中操作）')

    const existingId = this.findChannelByBotId(botId)
    if (existingId !== null) return fail(`该 bot 已是渠道：${existingId}`)

    let token: string
    try {
      token = await getManagedBotToken(manager.token, Number(botId))
    } catch (error) {
      return fail(`获取 token 失败：${errorMessage(error)}`)
    }

    const owner = channelOwner(store.current.users, managerId)
    const result = store.addManagedChannel(
      {
        managerId,
        channelId: discovery.username,
        settings: { type: 'telegram_bot', token, enabled: true, drop_pending_updates: false },
        owner: {
          userId: owner?.user_id ?? discovery.creatorId,
          name: owner?.name ?? discovery.creatorName ?? undefined,
        },
      },
      expectedVersion,
    )
    if (!result.ok) return result

    // 发现记录保留（渠道删除后凭它重新加回）；已添加的由 list 按 config 过滤
    this.emitFor(managerId)
    return { ok: true, channelId: discovery.username, state: result.state }
  }

  // ---------- 内部 ----------

  /** token 前缀 == bot user id（token 格式 <bot_id>:<secret>；username 可改名不做匹配依据） */
  private findChannelByBotId(botId: string): string | null {
    for (const [id, settings] of Object.entries(this.deps.store.current.channels)) {
      if (settings.type === 'telegram_bot' && settings.token.startsWith(`${botId}:`)) return id
    }
    return null
  }

  /** 比对最新 token，变了写回 config；token 属 restart-required 字段，hub 自动重启该渠道 */
  private async rotateTokenIfChanged(
    managerId: string,
    managerToken: string,
    channelId: string,
    botUserId: number,
  ): Promise<void> {
    const fresh = await getManagedBotToken(managerToken, botUserId)
    // conflict 重试 ≤3：每轮重读 settings，避免覆盖并发修改
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const settings = this.deps.store.current.channels[channelId]
      if (settings === undefined || settings.type !== 'telegram_bot') return
      if (settings.token === fresh) return
      const result = this.deps.store.upsertChannel(channelId, { ...settings, token: fresh }, this.deps.store.currentVersion)
      if (result.ok) {
        this.deps.log.info(`manager ${managerId}: 渠道 ${channelId} 的 token 已轮换，渠道将自动重启`)
        return
      }
      if (!result.conflict) {
        this.deps.log.error(`manager ${managerId}: 渠道 ${channelId} token 轮换写回失败：${result.message}`)
        return
      }
    }
    this.deps.log.error(`manager ${managerId}: 渠道 ${channelId} token 轮换持续版本冲突，放弃（下次事件重试）`)
  }

  private emitFor(managerId: string): void {
    this.deps.emit(managerId, this.list(managerId))
  }

  private reconcile(next: Config['manager_bots']): void {
    for (const id of Array.from(this.pollers.keys())) {
      const wanted = next[id]
      if (wanted === undefined) {
        void this.teardown(id, { removed: true })
        continue
      }
      const prevToken = this.runningTokens.get(id)
      if (prevToken !== undefined && prevToken !== wanted.token) {
        this.deps.log.info(`manager ${id}: token 变更，重启`)
        this.pendingRestarts.add(id)
        void this.teardown(id, { removed: false }).then(() => {
          this.pendingRestarts.delete(id)
          this.spawn(id)
        })
      } else {
        this.runningTokens.set(id, wanted.token) // managing 列表变更经读穿生效，不重启
      }
    }

    for (const id of Object.keys(next)) {
      if (!this.pollers.has(id) && !this.pendingRestarts.has(id)) this.spawn(id)
    }

    this.pushStatuses()
  }

  private spawn(id: string): void {
    if (this.pollers.has(id)) return
    const settings = this.deps.store.current.manager_bots[id]
    if (settings === undefined) return

    this.deps.log.info(`manager ${id}: 启动`)
    const poller = new TelegramManagerBotChannel({
      id,
      settingsRef: this.deps.store.ref<ManagerBotConfig>(`manager_bots.${id}`),
      onMessage: this.deps.onMessage,
      onManagedBotUpdate: (managerId, managerToken, ev) => {
        void this.handleManagedBotUpdate(managerId, managerToken, ev)
      },
      onStatus: () => this.pushStatuses(),
      log: this.deps.log,
      ...(this.deps.timings === undefined ? {} : { timings: this.deps.timings }),
    })
    this.pollers.set(id, poller)
    this.runningTokens.set(id, settings.token)

    void poller.start().catch((error: unknown) => {
      this.deps.log.error(`manager ${id} 启动失败：${errorMessage(error)}`)
    })
  }

  private async teardown(id: string, options: { removed: boolean }): Promise<void> {
    const poller = this.pollers.get(id)
    if (poller === undefined) return
    this.deps.log.info(`manager ${id}: 停止${options.removed ? '（配置已删除）' : ''}`)
    this.pollers.delete(id)
    this.runningTokens.delete(id)
    await poller.stop()
    if (options.removed) {
      // managed 渠道保留（managing 关系随 manager 一起消失）；发现记录清库
      this.deps.repo.deleteByManager(id)
      this.deps.emit(id, [])
    }
    this.pushStatuses()
  }

  private pushStatuses(): void {
    this.deps.onStatuses(this.statuses())
  }
}

function fail(message: string): AddManagedBotResult {
  return { ok: false, message, conflict: false }
}
