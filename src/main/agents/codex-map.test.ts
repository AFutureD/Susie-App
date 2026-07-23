import type { ThreadItem } from '@susie/codex-app-server'
import { describe, expect, it } from 'vitest'
import { mapThreadItem } from './codex-map'

describe('mapThreadItem', () => {
  it('maps agent messages to text and tools to quotes', () => {
    expect(mapThreadItem({ id: '1', type: 'agentMessage', text: 'hi', phase: null, memoryCitation: null })).toEqual([
      { kind: 'text', text: 'hi' },
    ])

    const command = mapThreadItem({
      id: '2',
      type: 'commandExecution',
      command: 'ls -la',
      cwd: '/tmp',
      processId: null,
      source: 'agent',
      status: 'completed',
      commandActions: [],
      aggregatedOutput: 'total 0',
      exitCode: 0,
      durationMs: null,
    } as unknown as ThreadItem)
    expect(command[0]).toMatchObject({ kind: 'quote', title: '[completed] ls -la' })
    expect((command[0] as { body: string }).body).toContain('exit_code: 0')

    const mcp = mapThreadItem({
      id: '3',
      type: 'mcpToolCall',
      server: 'susie_mcp_server',
      tool: 'send_message',
      status: 'failed',
      arguments: { a: 1 },
      appContext: null,
      pluginId: null,
      result: null,
      error: { message: 'boom' },
      durationMs: null,
    })
    expect(mcp[0]).toMatchObject({ kind: 'quote', title: '[failed] susie_mcp_server.send_message', body: 'boom' })

    const plan = mapThreadItem({ id: '4', type: 'plan', text: '- [x] a\n- [ ] b' })
    expect((plan[0] as { body: string }).body).toBe('- [x] a\n- [ ] b')

    const files = mapThreadItem({
      id: '5',
      type: 'fileChange',
      status: 'completed',
      changes: [{ path: '/tmp/a.ts', kind: { type: 'add' }, diff: '' }],
    })
    expect(files[0]).toMatchObject({ kind: 'quote', title: '[completed] file changes', body: 'add: /tmp/a.ts' })

    const reasoning = mapThreadItem({ id: '6', type: 'reasoning', summary: ['s'], content: ['c'] })
    expect(reasoning[0]).toMatchObject({ kind: 'quote', title: '[reasoning]', body: 's\nc' })
  })

  it('drops empty agent messages and unknown item types', () => {
    expect(mapThreadItem({ id: '7', type: 'agentMessage', text: '', phase: null, memoryCitation: null })).toEqual([])
    expect(mapThreadItem({ id: '8', type: 'contextCompaction' })).toEqual([])
  })
})
