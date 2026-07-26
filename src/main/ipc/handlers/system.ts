import fs from 'node:fs'
import log from 'electron-log/main'
import { errorLog } from '../../logging'
import { checkForUpdates, getUpdateState, quitAndInstall } from '../../updater'
import type { IpcHandlers } from '../router'

export function logsHandlers(): IpcHandlers['logs'] {
  return {
    tail: ({ lines, file }) => {
      const logger = file === 'error' ? errorLog : log
      const logFile = logger.transports.file.getFile().path
      try {
        const text = fs.readFileSync(logFile, 'utf-8')
        const allLines = text.split('\n')
        const count = Math.min(Math.max(lines ?? 300, 10), 2000)
        return { path: logFile, lines: allLines.slice(-count) }
      } catch {
        return { path: logFile, lines: [] }
      }
    },
  }
}

export function updateHandlers(): IpcHandlers['update'] {
  return {
    check: () => checkForUpdates(),
    install: () => quitAndInstall(),
    getState: () => getUpdateState(),
  }
}
