import type { ChannelSettings, Config } from '../../shared/config'
import type { ChannelStatus, InboundEnvelope } from '../../shared/messages'
import { errorMessage } from '../../shared/errors'
import type { ConfigStore, Unsubscribe } from '../config/store'
import type { CommandSpec } from '../core/commands'
import type { Logger } from '../util/logger'
import type { Channel, ChannelCallbackEvent, ChannelFactory } from './types'

export interface ChannelHubDeps {
  store: ConfigStore
  /** 按 config discriminant（settings.type）注册的通道工厂；组合根装配 */
  factories: ReadonlyMap<string, ChannelFactory>
  attachmentsDir: string
  listCommands: () => CommandSpec[]
  /** 可执行需审核命令的用户（owner + 私聊直通档）——其私聊注册完整命令菜单 */
  listPrivilegedUserIds: (channelId: string) => string[]
  onMessage: (envelope: InboundEnvelope) => void
  onCallback: (event: ChannelCallbackEvent) => void
  onStatuses: (statuses: ChannelStatus[]) => void
  onChannelRemoved: (channelId: string) => void
  log: Logger
}

/**
 * 通道生命周期编排（平台无关）：由配置驱动（新增→启动，删除→停机，
 * restart-required 字段变更→重启，enabled 开关→启停）。
 * 平台差异（哪些字段需重启、如何实例化）由 ChannelFactory 承担。
 * 热加载经 ConfigStore 的 'channels' path 订阅进入 reconcile。
 */
export class ChannelHub {
  private readonly deps: ChannelHubDeps
  private readonly channels = new Map<string, Channel>()
  private readonly runningSettings = new Map<string, ChannelSettings>()
  /** 正在重启（teardown 进行中）的通道：reconcile 的补启动循环必须跳过，防双重 spawn */
  private readonly pendingRestarts = new Set<string>()
  private unsubscribe: Unsubscribe | null = null

  constructor(deps: ChannelHubDeps) {
    this.deps = deps
  }

  start(): void {
    this.reconcile(this.deps.store.current.channels)
    this.unsubscribe = this.deps.store.subscribePath('channels', (next) => {
      this.reconcile((next ?? {}) as Config['channels'])
    })
  }

  get(id: string): Channel | undefined {
    return this.channels.get(id)
  }

  /** 权限名单变化后重新同步所有运行中通道的命令菜单 */
  refreshCommandMenus(): void {
    for (const channel of this.channels.values()) {
      void channel.refreshCommandMenus()
    }
  }

  statuses(): ChannelStatus[] {
    const result: ChannelStatus[] = []
    for (const [id, settings] of Object.entries(this.deps.store.current.channels)) {
      const instance = this.channels.get(id)
      if (instance !== undefined) {
        result.push(instance.status())
      } else {
        result.push({ id, state: 'stopped', detail: settings.enabled ? null : '已禁用' })
      }
    }
    return result
  }

  async stopAll(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    await Promise.all(Array.from(this.channels.keys()).map((id) => this.teardown(id, { notifyRemoved: false })))
  }

  /** 是否需要重启实例（类型切换一律重启；未知类型交给 spawn 报错） */
  private restartRequired(prev: ChannelSettings, next: ChannelSettings): boolean {
    if (prev.type !== next.type) return true
    const factory = this.deps.factories.get(next.type)
    return factory === undefined ? true : factory.restartRequired(prev, next)
  }

  private reconcile(next: Config['channels']): void {
    const wanted = new Map(Object.entries(next).filter(([, settings]) => settings.enabled))

    for (const id of Array.from(this.channels.keys())) {
      const settings = wanted.get(id)
      if (settings === undefined) {
        void this.teardown(id, { notifyRemoved: !(id in next) })
        continue
      }
      const prev = this.runningSettings.get(id)
      if (prev !== undefined && this.restartRequired(prev, settings)) {
        this.deps.log.info(`channel ${id}: restart-required 字段变更，重启`)
        // teardown 的同步段就会从 channels 摘除该 id——必须标记重启中，
        // 否则下方补启动循环会先 spawn 一次，teardown 完成后再 spawn 第二次，
        // 旧实例被覆盖成孤儿继续 polling（Telegram 409 互踢）。
        this.pendingRestarts.add(id)
        void this.teardown(id, { notifyRemoved: false }).then(() => {
          this.pendingRestarts.delete(id)
          this.spawn(id)
        })
      } else {
        this.runningSettings.set(id, settings)
      }
    }

    for (const id of wanted.keys()) {
      if (!this.channels.has(id) && !this.pendingRestarts.has(id)) this.spawn(id)
    }

    this.pushStatuses()
  }

  private spawn(id: string): void {
    // 防御重复 spawn：已有实例绝不覆盖（覆盖会把旧实例变成不可停机的孤儿）
    if (this.channels.has(id)) return
    const settings = this.deps.store.current.channels[id]
    if (settings === undefined || !settings.enabled) return

    const factory = this.deps.factories.get(settings.type)
    if (factory === undefined) {
      this.deps.log.error(`channel ${id}: 未注册的通道类型 "${settings.type}"`)
      return
    }

    this.deps.log.info(`channel ${id}: 启动`)
    const channel = factory.create(id, this.deps.store.ref<ChannelSettings>(`channels.${id}`), {
      attachmentsDir: this.deps.attachmentsDir,
      listCommands: this.deps.listCommands,
      listPrivilegedUserIds: this.deps.listPrivilegedUserIds,
      onMessage: this.deps.onMessage,
      onCallback: this.deps.onCallback,
      onStatus: () => this.pushStatuses(),
      log: this.deps.log,
    })
    this.channels.set(id, channel)
    this.runningSettings.set(id, settings)

    void channel.start().catch((error: unknown) => {
      this.deps.log.error(`channel ${id} 启动失败：${errorMessage(error)}`)
    })
  }

  private async teardown(id: string, options: { notifyRemoved: boolean }): Promise<void> {
    const channel = this.channels.get(id)
    if (channel === undefined) return
    this.deps.log.info(`channel ${id}: 停止${options.notifyRemoved ? '（配置已删除）' : ''}`)
    this.channels.delete(id)
    this.runningSettings.delete(id)
    await channel.stop()
    if (options.notifyRemoved) this.deps.onChannelRemoved(id)
    this.pushStatuses()
  }

  private pushStatuses(): void {
    this.deps.onStatuses(this.statuses())
  }
}
