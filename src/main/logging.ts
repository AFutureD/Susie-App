import log from 'electron-log/main'
import type { Logger } from './util/logger'

/**
 * error 专用日志实例：与 main.log 并列写 error.log，只收 error 级别。
 * main.log 保留完整时间线（info+），error.log 用于出问题时快速定位。
 */
export const errorLog = log.create({ logId: 'error' })

export function setupLogging(): void {
  log.initialize()
  log.transports.file.level = 'info'
  log.errorHandler.startCatching()

  errorLog.transports.file.fileName = 'error.log'
  errorLog.transports.file.level = 'error'
  errorLog.transports.console.level = false
  errorLog.transports.ipc.level = false

  // 主 logger 的所有 error 级输出（含 errorHandler 捕获的未处理异常）自动镜像到 error.log。
  // 只在 file transport 这一次触发，避免 console/ipc transport 造成重复镜像。
  log.hooks.push((message, transport) => {
    if (message.level === 'error' && transport === log.transports.file) {
      errorLog.error(...(message.data as unknown[]))
    }
    return message
  })
}

/** 注入服务层的分级日志 */
export const serviceLogger: Logger = {
  info: (message) => log.info(message),
  error: (message) => log.error(message),
}
