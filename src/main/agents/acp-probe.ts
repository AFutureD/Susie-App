import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

export interface AcpProbeTarget {
  cmd: string
  args: string[]
  env: Record<string, string>
}

/**
 * 探测 ACP agent 的 MCP 能力：spawn 后发一次 initialize，读
 * agentCapabilities.mcpCapabilities.http。susie 只会以 http 分发注入
 * MCP server（send_message 等）——不支持 http 的 agent（如 pi-acp）会
 * 静默忽略注入，工具不可用，需要在安装时就提示出来。
 *
 * npx 分发首次 spawn 会触发 npm 下载，超时给足；失败抛错（调用方记 unknown）。
 */
export async function probeAcpMcpHttp(target: AcpProbeTarget, timeoutMs = 60_000): Promise<boolean> {
  const child = spawn(target.cmd, target.args, {
    env: { ...process.env, ...target.env },
    stdio: ['pipe', 'pipe', 'ignore'],
  })

  try {
    return await new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`acp initialize 探测超时（${timeoutMs}ms）`)), timeoutMs)
      const fail = (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
      child.once('error', (error) => fail(new Error(`acp agent 启动失败：${error.message}`)))
      child.on('exit', (code) => fail(new Error(`acp agent 提前退出（code=${code ?? 'null'}）`)))

      const rl = readline.createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        let message: { id?: unknown; result?: { agentCapabilities?: { mcpCapabilities?: { http?: unknown } } } }
        try {
          message = JSON.parse(line) as typeof message
        } catch {
          return // 非 JSON 噪音行（不合协议但无害），继续等响应
        }
        if (message.id !== 1) return
        clearTimeout(timer)
        resolve(message.result?.agentCapabilities?.mcpCapabilities?.http === true)
      })

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          },
        })}\n`,
      )
    })
  } finally {
    child.kill()
  }
}
