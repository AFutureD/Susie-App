import type { ChannelSettings, Config, TelegramBotChannelSettings } from '../../shared/config'
import type { ChannelStatus } from '../../shared/messages'
import type { ConfigRef, ConfigStore, Unsubscribe } from '../config/store'
import type { Logger } from '../util/logger'
import { TelegramBotChannel, type InboundEnvelope } from './telegram-bot'

export interface ChannelHubDeps {
  store: ConfigStore
  attachmentsDir: string
  onMessage: (envelope: InboundEnvelope) => void
  onStatuses: (statuses: ChannelStatus[]) => void
  onChannelRemoved: (channelId: string) => void
  log: Logger
}

/** 需要重启通道的字段；其余字段（白名单/群策略等）经 ConfigRef 读穿即刻生效 */
function restartRequired(prev: ChannelSettings, next: ChannelSettings): boolean {
  return prev.token !== next.token || prev.drop_pending_updates !== next.drop_pending_updates
}

/**
 * 通道生命周期：由配置驱动（新增→启动，删除→停机，restart-required 字段变更→重启，
 * enabled 开关→启停）。热加载经 ConfigStore 的 'channels' path 订阅进入 reconcile。
 */
export class ChannelHub {
  private readonly deps: ChannelHubDeps
  private readonly channels = new Map<string, TelegramBotChannel>()
  private readonly runningSettings = new Map<string, ChannelSettings>()
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

  get(id: string): TelegramBotChannel | undefined {
    return this.channels.get(id)
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

  private reconcile(next: Config['channels']): void {
    const wanted = new Map(Object.entries(next).filter(([, settings]) => settings.enabled))

    for (const id of Array.from(this.channels.keys())) {
      const settings = wanted.get(id)
      if (settings === undefined) {
        void this.teardown(id, { notifyRemoved: !(id in next) })
        continue
      }
      const prev = this.runningSettings.get(id)
      if (prev !== undefined && restartRequired(prev, settings)) {
        this.deps.log.info(`channel ${id}: restart-required 字段变更，重启`)
        void this.teardown(id, { notifyRemoved: false }).then(() => this.spawn(id))
      } else {
        this.runningSettings.set(id, settings)
      }
    }

    for (const id of wanted.keys()) {
      if (!this.channels.has(id)) this.spawn(id)
    }

    this.pushStatuses()
  }

  private spawn(id: string): void {
    const settings = this.deps.store.current.channels[id]
    if (settings === undefined || !settings.enabled) return

    this.deps.log.info(`channel ${id}: 启动`)
    const channel = new TelegramBotChannel({
      id,
      settingsRef: this.deps.store.ref(`channels.${id}`) as ConfigRef<TelegramBotChannelSettings>,
      attachmentsDir: this.deps.attachmentsDir,
      onMessage: this.deps.onMessage,
      onStatus: () => this.pushStatuses(),
      log: this.deps.log,
    })
    this.channels.set(id, channel)
    this.runningSettings.set(id, settings)

    void channel.start().catch((error: unknown) => {
      this.deps.log.error(`channel ${id} 启动失败：${error instanceof Error ? error.message : String(error)}`)
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
