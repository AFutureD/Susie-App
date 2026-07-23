/** 主进程分级日志接口：info 为常规流水，error 会以 error 级别落盘（Logs 页可排查） */
export interface Logger {
  info: (message: string) => void
  error: (message: string) => void
}
