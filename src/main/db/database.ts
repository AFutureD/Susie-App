import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runMigrations } from './migrations'

/**
 * 应用数据库：单文件单连接（node:sqlite，零原生依赖），WAL 模式，
 * 打开即跑版本化迁移（db/migrations.ts）。各领域 repo 共享此连接。
 */
export class AppDatabase {
  readonly db: DatabaseSync

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    runMigrations(this.db)
  }

  close(): void {
    this.db.close()
  }
}
