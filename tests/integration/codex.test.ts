import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexRuntime } from '../../src/main/agents/codex'
import { CodexInstaller } from '../../src/main/agents/codex-installer'
import type { AgentTurn } from '../../src/main/agents/types'
import { SusieMcpServer, type McpBridge } from '../../src/main/mcp/server'
import type { StoredMessage } from '../../src/shared/messages'

// 真实 codex 集成测试（走 node_modules 里的 codex 二进制与本机登录态）。
// 默认跳过；SUSIE_CODEX_IT=1 时启用：npm run test:codex

const enabled = process.env['SUSIE_CODEX_IT'] === '1'

function resolveCodex(): { codexPath: string; codexPathDir: string | null } {
  const resolved = new CodexInstaller(mkdtempSync(path.join(tmpdir(), 'susie-codex-data-'))).resolve()
  if (resolved === null) throw new Error('codex 不可用：node_modules 与 PATH 均未找到')
  return { codexPath: resolved.executablePath, codexPathDir: resolved.pathDir }
}

async function lastTurn(runtime: CodexRuntime, prompt: string): Promise<AgentTurn> {
  let last: AgentTurn | null = null
  for await (const turn of runtime.prompt(prompt)) {
    last = turn
  }
  if (last === null) throw new Error('no turn produced')
  return last
}

describe.skipIf(!enabled)('codex integration', () => {
  it('enumerates models via app-server probe', { timeout: 60_000 }, async () => {
    const runtime = new CodexRuntime({
      cwd: mkdtempSync(path.join(tmpdir(), 'susie-codex-models-')),
      mcpUrl: null,
      mcpName: 'susie_mcp_server',
      model: null,
      thinkingLevel: null,
      models: [],
      ...resolveCodex(),
    })
    const options = await runtime.listModels()
    expect(options.length).toBeGreaterThan(0)
    expect(options[0]).toHaveProperty('value')
    expect(options[0]).toHaveProperty('name')
    await runtime.dispose()
  })

  it('completes a plain turn', { timeout: 180_000 }, async () => {
    const runtime = new CodexRuntime({
      cwd: mkdtempSync(path.join(tmpdir(), 'susie-codex-')),
      mcpUrl: null,
      mcpName: 'susie_mcp_server',
      model: null,
      thinkingLevel: null,
      models: [],
      ...resolveCodex(),
    })
    await runtime.newSession('You are a test probe. Follow instructions exactly.')

    const turn = await lastTurn(runtime, 'Reply with exactly: pong')
    expect(turn.status).toBe('completed')
    const text = turn.parts
      .filter((part) => part.kind === 'text')
      .map((part) => (part as { text: string }).text)
      .join('\n')
    expect(text.toLowerCase()).toContain('pong')
    await runtime.dispose()
  })

  it('calls susie mcp send_message end-to-end', { timeout: 240_000 }, async () => {
    const sent: { channelId: string; chatId: string; content: string }[] = []
    const fake: StoredMessage = {
      rowid: 1,
      id: '1',
      channelId: 'ch',
      chatId: 'P:1',
      receiver: null,
      replyTo: null,
      out: true,
      sender: 'susie',
      senderId: null,
      timestamp: Date.now(),
      parts: [],
    }
    const bridge: McpBridge = {
      sendMessage: (input) => {
        sent.push({ channelId: input.channelId, chatId: input.chatId, content: input.content })
        return Promise.resolve(fake)
      },
      listMessages: () => [],
      listChats: () => [],
    }

    const mcp = new SusieMcpServer()
    mcp.setBridge(bridge)
    const url = await mcp.start(0)

    try {
      const runtime = new CodexRuntime({
        cwd: mkdtempSync(path.join(tmpdir(), 'susie-codex-mcp-')),
        mcpUrl: url,
        mcpName: 'susie_mcp_server',
        model: null,
        thinkingLevel: null,
        models: [],
        ...resolveCodex(),
      })
      await runtime.newSession(null)

      const turn = await lastTurn(
        runtime,
        'Use the susie_mcp_server send_message tool with channel_id "ch", chat_id "P:1", content "pong from codex". Then reply done.',
      )
      expect(turn.error).toBeNull()
      expect(turn.status).toBe('completed')
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ channelId: 'ch', chatId: 'P:1' })
      expect(sent[0]?.content.toLowerCase()).toContain('pong')
      await runtime.dispose()
    } finally {
      await mcp.stop()
    }
  })
})
