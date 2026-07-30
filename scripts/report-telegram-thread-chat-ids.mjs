#!/usr/bin/env node
// 只读盘点：列出 Telegram 历史/绑定/定时任务里所有带第三段的 chat_id（旧「普通线程被误当 Topic」污染）。
// 只打印结果，绝不迁移或改写；输出用于人工确认并回填基础会话 binding。
//
// 用法：
//   node scripts/report-telegram-thread-chat-ids.mjs
//     默认扫描 macOS 常规位置：
//       历史库 → ~/Library/Application Support/Susie/history.db
//       配置文件 → $SUSIE_CONFIG_DIR/config.toml（未设置时 ~/.config/susie/config.toml）
//   可覆盖：SUSIE_HISTORY_DB=/path/to/history.db SUSIE_CONFIG_DIR=/path/to/config-dir
//   CLI：--history-db=<path>、--config=<path>
//
// 退出码：0 = 一切正常（无论是否发现记录）；非 0 = 输入错误或读取失败。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { parse as parseToml } from 'smol-toml'

const HELP = `报告 Telegram 带第三段的 chat_id（只读盘点）
用法：node scripts/report-telegram-thread-chat-ids.mjs [--history-db=<path>] [--config=<path>]
环境变量：SUSIE_HISTORY_DB / SUSIE_CONFIG_DIR
`

function parseCli(argv) {
  const out = { historyDb: null, config: null }
  for (const arg of argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP)
      process.exit(0)
    } else if (arg.startsWith('--history-db=')) {
      out.historyDb = arg.slice('--history-db='.length)
    } else if (arg.startsWith('--config=')) {
      out.config = arg.slice('--config='.length)
    } else {
      process.stderr.write(`未知参数：${arg}\n${HELP}`)
      process.exit(2)
    }
  }
  return out
}

function defaultHistoryDb() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Susie', 'history.db')
  }
  // linux/windows：Electron userData 分别位于 ~/.config/Susie 与 %APPDATA%/Susie
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'Susie', 'history.db')
  }
  const xdg = process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config')
  return path.join(xdg, 'Susie', 'history.db')
}

function defaultConfigPath() {
  const override = process.env['SUSIE_CONFIG_DIR']
  const base =
    override && override !== ''
      ? override
      : path.join(process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config'), 'susie')
  return path.join(base, 'config.toml')
}

/** 匹配 <前缀>:<int>:<int> 形式的 chat_id（第三段存在即视为潜在污染） */
const THIRD_SEGMENT = /^[PGSCX]:-?\d+:\d+$/

function scanDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    return { present: false, findings: [] }
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const findings = []
  try {
    const push = (source, rows) => {
      for (const row of rows) {
        if (!THIRD_SEGMENT.test(row.chat_id)) continue
        findings.push({
          source,
          channelId: row.channel_id,
          chatId: row.chat_id,
          extras: row.extras ?? null,
        })
      }
    }

    // 历史消息
    const messages = db
      .prepare(
        `SELECT channel_id, chat_id, COUNT(*) AS extras
           FROM messages
          WHERE chat_id LIKE '_:%:%'
          GROUP BY channel_id, chat_id
          ORDER BY channel_id, chat_id`,
      )
      .all()
    push('messages(count)', messages)

    // 会话索引
    const chats = db
      .prepare(
        `SELECT channel_id, chat_id, name AS extras FROM chats
          WHERE chat_id LIKE '_:%:%'
          ORDER BY channel_id, chat_id`,
      )
      .all()
    push('chats(name)', chats)

    // 未决审核（重启后卡片按钮仍要可用）
    const pending = db
      .prepare(
        `SELECT channel_id, chat_id, status AS extras FROM pending_approvals
          WHERE chat_id LIKE '_:%:%'
          ORDER BY channel_id, chat_id`,
      )
      .all()
    push('pending_approvals(status)', pending)
  } finally {
    db.close()
  }
  return { present: true, findings }
}

function scanConfig(configPath) {
  if (!fs.existsSync(configPath)) return { present: false, findings: [] }
  const raw = fs.readFileSync(configPath, 'utf8')
  const parsed = parseToml(raw)
  const findings = []
  const record = (source, channelId, chatId, extras) => {
    if (typeof chatId !== 'string' || !THIRD_SEGMENT.test(chatId)) return
    findings.push({ source, channelId: String(channelId ?? ''), chatId, extras: extras ?? null })
  }
  for (const binding of Array.isArray(parsed.bindings) ? parsed.bindings : []) {
    record('bindings', binding?.channel, binding?.chat_id, binding?.assistant_id ?? null)
  }
  for (const task of Array.isArray(parsed.scheduled_tasks) ? parsed.scheduled_tasks : []) {
    const taskId = task?.id ?? '?'
    for (const target of Array.isArray(task?.targets) ? task.targets : []) {
      record(`scheduled_tasks[${taskId}].targets`, target?.channel, target?.chat_id, taskId)
    }
  }
  return { present: true, findings }
}

function report(title, result) {
  process.stdout.write(`\n== ${title} ==\n`)
  if (!result.present) {
    process.stdout.write('  (来源不存在，跳过)\n')
    return
  }
  if (result.findings.length === 0) {
    process.stdout.write('  未发现带第三段的 chat_id\n')
    return
  }
  for (const item of result.findings) {
    const extra = item.extras === null || item.extras === '' ? '' : `  [${item.extras}]`
    process.stdout.write(`  ${item.source.padEnd(30)}  ${item.channelId}  ${item.chatId}${extra}\n`)
  }
}

function main() {
  const cli = parseCli(process.argv)
  const historyDbPath = cli.historyDb ?? process.env['SUSIE_HISTORY_DB'] ?? defaultHistoryDb()
  const configPath = cli.config ?? defaultConfigPath()

  process.stdout.write(`历史库：${historyDbPath}\n`)
  process.stdout.write(`配置文件：${configPath}\n`)

  const dbResult = scanDb(historyDbPath)
  const cfgResult = scanConfig(configPath)

  report('history db (messages/chats/pending_approvals)', dbResult)
  report('config bindings & scheduled_tasks', cfgResult)

  const total = (dbResult.findings?.length ?? 0) + (cfgResult.findings?.length ?? 0)
  process.stdout.write(`\n合计：${total} 条带第三段的 chat_id\n`)
  if (total > 0) {
    process.stdout.write('\n提示：上线前请人工确认这些第三段的来源——真 Topic 与普通线程的处理方式不同，\n')
    process.stdout.write('      修复后普通线程会归入基础会话，旧 binding 需手工回填基础 chat_id。\n')
  }
}

main()
