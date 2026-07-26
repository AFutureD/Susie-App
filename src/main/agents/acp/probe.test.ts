import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeAcpMcpHttp } from './probe'

/** 假 ACP agent：读一行 initialize 请求，回指定 capabilities（借 node 执行，免依赖 shell） */
function fakeAgent(mcpCapabilities: string): { cmd: string; args: string[]; env: Record<string, string> } {
  const dir = mkdtempSync(path.join(tmpdir(), 'susie-acp-probe-test-'))
  const file = path.join(dir, 'agent.mjs')
  writeFileSync(
    file,
    `import readline from 'node:readline'
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', () => {
  console.log('log noise')
  console.log(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: ${mcpCapabilities} } }))
})
`,
    'utf-8',
  )
  return { cmd: process.execPath, args: [file], env: {} }
}

describe('probeAcpMcpHttp', () => {
  it('支持 http MCP 的 agent 返回 true（容忍 stdout 噪音行）', async () => {
    await expect(probeAcpMcpHttp(fakeAgent('{ mcpCapabilities: { http: true, sse: false } }'))).resolves.toBe(true)
  })

  it('不支持 http MCP（如 pi-acp）返回 false', async () => {
    await expect(probeAcpMcpHttp(fakeAgent('{ mcpCapabilities: { http: false, sse: false } }'))).resolves.toBe(false)
  })

  it('未宣告 mcpCapabilities 视为不支持', async () => {
    await expect(probeAcpMcpHttp(fakeAgent('{}'))).resolves.toBe(false)
  })

  it('agent 无法启动时报错', async () => {
    await expect(probeAcpMcpHttp({ cmd: '/nonexistent/agent-binary', args: [], env: {} }, 2000)).rejects.toThrow(
      '启动失败',
    )
  })

  it('agent 不响应时按超时报错', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'susie-acp-probe-test-'))
    const file = path.join(dir, 'silent.mjs')
    writeFileSync(file, `setTimeout(() => {}, 60_000)`, 'utf-8')
    await expect(probeAcpMcpHttp({ cmd: process.execPath, args: [file], env: {} }, 300)).rejects.toThrow('超时')
  })
})
