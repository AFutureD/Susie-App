import type { DatabaseSync } from 'node:sqlite'
import type { ManagedBotDiscovery } from '../../../shared/messages'
import type { AppDatabase } from '../../db/database'

// managed bot 发现记录的持久层（telegram 域拥有；与对话历史同库不同表）。
// Telegram getUpdates 的 offset 确认后事件不重推——不落库一次重启就永久丢失，
// 「流程外创建的 bot 之后仍可添加」全靠这张表。existingChannelId 是对照
// 当前 config 的现算值，不在此层，由 ManagedBotRegistry 在 list 时补充。

export type StoredManagedBotDiscovery = Omit<ManagedBotDiscovery, 'existingChannelId'>

interface DiscoveryRow {
  manager_id: string
  bot_id: string
  username: string
  name: string
  creator_id: string
  creator_name: string | null
  discovered_ts: number
}

function rowToDiscovery(row: DiscoveryRow): StoredManagedBotDiscovery {
  return {
    managerId: row.manager_id,
    botId: row.bot_id,
    username: row.username,
    name: row.name,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    discoveredTs: row.discovered_ts,
  }
}

export class DiscoveryRepo {
  private readonly db: DatabaseSync

  constructor(database: AppDatabase) {
    this.db = database.db
  }

  /** 同一 (manager, bot) 的重复事件幂等覆盖（username/name 可能已变，取最新） */
  upsert(discovery: StoredManagedBotDiscovery): void {
    this.db
      .prepare(
        `INSERT INTO managed_bot_discoveries(manager_id, bot_id, username, name, creator_id, creator_name, discovered_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(manager_id, bot_id) DO UPDATE SET
           username = excluded.username,
           name = excluded.name,
           creator_id = excluded.creator_id,
           creator_name = excluded.creator_name,
           discovered_ts = excluded.discovered_ts`,
      )
      .run(
        discovery.managerId,
        discovery.botId,
        discovery.username,
        discovery.name,
        discovery.creatorId,
        discovery.creatorName,
        discovery.discoveredTs,
      )
  }

  /** 某 manager 的全部发现（新 → 旧） */
  listByManager(managerId: string): StoredManagedBotDiscovery[] {
    const rows = this.db
      .prepare('SELECT * FROM managed_bot_discoveries WHERE manager_id = ? ORDER BY discovered_ts DESC, bot_id')
      .all(managerId) as unknown as DiscoveryRow[]
    return rows.map(rowToDiscovery)
  }

  get(managerId: string, botId: string): StoredManagedBotDiscovery | null {
    const row = this.db
      .prepare('SELECT * FROM managed_bot_discoveries WHERE manager_id = ? AND bot_id = ?')
      .get(managerId, botId) as unknown as DiscoveryRow | undefined
    return row === undefined ? null : rowToDiscovery(row)
  }

  /** 添加成功后移除该条发现 */
  delete(managerId: string, botId: string): void {
    this.db.prepare('DELETE FROM managed_bot_discoveries WHERE manager_id = ? AND bot_id = ?').run(managerId, botId)
  }

  /** manager 删除时清空其全部发现 */
  deleteByManager(managerId: string): void {
    this.db.prepare('DELETE FROM managed_bot_discoveries WHERE manager_id = ?').run(managerId)
  }
}
