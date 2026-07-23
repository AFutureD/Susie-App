// codex 模型枚举（对位 Python openai_codex 的 codex.models()）：
// exec SDK（@openai/codex-sdk）没有模型接口，这里起一个一次性的
// `codex app-server` 子进程走 JSON-RPC 的 model/list，拿到后即杀。
// 协议注意：响应到达前 stdin 必须保持打开，否则进程随 EOF 退出。

import { spawn } from 'node:child_process'
import type { AgentModelOption } from './types'

const LIST_REQUEST_ID = 2

/** model/list 响应 data → 候选列表（过滤 hidden，displayName/description 缺省回退） */
export function mapAppServerModels(data: unknown): AgentModelOption[] {
  if (!Array.isArray(data)) return []
  const options: AgentModelOption[] = []
  for (const item of data) {
    const record = item as Record<string, unknown>
    if (record['hidden'] === true) continue
    const value = typeof record['model'] === 'string' ? record['model'] : ''
    if (value === '') continue
    const displayName = record['displayName']
    const description = record['description']
    options.push({
      value,
      name: typeof displayName === 'string' && displayName !== '' ? displayName : value,
      ...(typeof description === 'string' && description !== '' ? { description } : {}),
    })
  }
  return options
}

export interface FetchCodexModelsOptions {
  /** codex 可执行文件路径；'codex' 表示交给 PATH */
  codexPath: string
  /** 传给子进程的环境（undefined 继承当前进程） */
  env?: Record<string, string>
  timeoutMs?: number
}

export function fetchCodexModels(options: FetchCodexModelsOptions): Promise<AgentModelOption[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.codexPath, ['app-server'], {
      stdio: ['pipe', 'pipe', 'ignore'],
      ...(options.env === undefined ? {} : { env: options.env }),
    })

    let done = false
    const finish = (error: Error | null, models: AgentModelOption[] = []) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.kill()
      if (error === null) resolve(models)
      else reject(error)
    }
    const timer = setTimeout(() => finish(new Error('codex app-server model/list 超时')), options.timeoutMs ?? 15_000)

    child.on('error', (error) => finish(error))
    child.on('exit', () => finish(new Error('codex app-server 提前退出')))

    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue
        let message: { id?: unknown; result?: unknown; error?: { message?: unknown } }
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          continue
        }
        if (message.id !== LIST_REQUEST_ID) continue
        if (message.error !== undefined) {
          finish(new Error(`model/list 失败：${String(message.error.message ?? 'unknown')}`))
        } else {
          finish(null, mapAppServerModels((message.result as { data?: unknown } | undefined)?.data))
        }
        return
      }
    })

    const send = (payload: object) => child.stdin.write(`${JSON.stringify(payload)}\n`)
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'susie-app', title: 'Susie', version: '0' } },
    })
    send({ jsonrpc: '2.0', method: 'initialized' })
    send({ jsonrpc: '2.0', id: LIST_REQUEST_ID, method: 'model/list', params: {} })
  })
}
