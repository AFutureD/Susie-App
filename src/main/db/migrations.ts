import type { DatabaseSync } from 'node:sqlite'

// 版本化迁移框架：PRAGMA user_version 记录已应用的最高迁移 id（桌面单写者场景，
// 不需要 applied-ids 元表）。id 必须严格递增；每条迁移在事务内执行，失败回滚并抛出。
//
// 兼容既有库：迁移框架引入之前的库 user_version = 0 但表可能已建、列可能已由旧 if 链补过，
// 因此迁移 1–3 全部写成幂等（IF NOT EXISTS / 列存在守卫），把「今天的现实」固化为基线。

export interface Migration {
  id: number
  comment: string
  up(db: DatabaseSync): void
}

/** 最新完整 schema（新库经迁移 1 一步建成；老库上全部 IF NOT EXISTS 为 no-op） */
const BASELINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS messages(
  rowid INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  msg_id TEXT,
  sender TEXT,
  sender_id TEXT,
  reply_to TEXT,
  receiver TEXT,
  out INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  parts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(channel_id, chat_id, ts);
CREATE TABLE IF NOT EXISTS chats(
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  name TEXT,
  last_ts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id, chat_id)
);
CREATE TABLE IF NOT EXISTS pending_approvals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT,
  sender TEXT,
  envelope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  card_chat_id TEXT,
  card_msg_id TEXT,
  auto_review_reason TEXT,
  created_ts INTEGER NOT NULL,
  decided_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status, channel_id);
CREATE TABLE IF NOT EXISTS auto_reviews(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT,
  sender TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  reason TEXT,
  created_ts INTEGER NOT NULL,
  decided_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auto_reviews_created ON auto_reviews(created_ts);
`

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
  return columns.some((item) => item.name === column)
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    comment: 'baseline：messages/chats/pending_approvals/auto_reviews 建表建索引',
    up(db) {
      db.exec(BASELINE_SCHEMA)
    },
  },
  {
    id: 2,
    comment: 'messages.sender_id 补列（迁移框架前的老库；列存在守卫幂等）',
    up(db) {
      if (!hasColumn(db, 'messages', 'sender_id')) db.exec('ALTER TABLE messages ADD COLUMN sender_id TEXT')
    },
  },
  {
    id: 3,
    comment: 'pending_approvals.auto_review_reason 补列（同上）',
    up(db) {
      if (!hasColumn(db, 'pending_approvals', 'auto_review_reason')) {
        db.exec('ALTER TABLE pending_approvals ADD COLUMN auto_review_reason TEXT')
      }
    },
  },
]

export function runMigrations(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  for (let index = 1; index < migrations.length; index += 1) {
    const prev = migrations[index - 1]
    const next = migrations[index]
    if (prev !== undefined && next !== undefined && next.id <= prev.id) {
      throw new Error(`db 迁移 id 必须严格递增：#${prev.id} → #${next.id}`)
    }
  }

  const row = db.prepare('PRAGMA user_version').get() as unknown as { user_version: number } | undefined
  const current = Number(row?.user_version ?? 0)

  for (const migration of migrations) {
    if (migration.id <= current) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.id}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`db 迁移 #${migration.id}（${migration.comment}）失败`, { cause: error })
    }
  }
}
