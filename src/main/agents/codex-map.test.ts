import { describe, expect, it } from 'vitest'
import { mapThreadItem } from './codex-map'

describe('mapThreadItem', () => {
  it('maps agent messages to text and tools to quotes', () => {
    expect(mapThreadItem({ id: '1', type: 'agent_message', text: 'hi' })).toEqual([{ kind: 'text', text: 'hi' }])

    const command = mapThreadItem({
      id: '2',
      type: 'command_execution',
      command: 'ls -la',
      aggregated_output: 'total 0',
      exit_code: 0,
      status: 'completed',
    })
    expect(command[0]).toMatchObject({ kind: 'quote', title: '[completed] ls -la' })
    expect((command[0] as { body: string }).body).toContain('exit_code: 0')

    const mcp = mapThreadItem({
      id: '3',
      type: 'mcp_tool_call',
      server: 'susie_mcp_server',
      tool: 'send_message',
      arguments: { a: 1 },
      status: 'failed',
      error: { message: 'boom' },
    })
    expect(mcp[0]).toMatchObject({ kind: 'quote', title: '[failed] susie_mcp_server.send_message', body: 'boom' })

    const todo = mapThreadItem({
      id: '4',
      type: 'todo_list',
      items: [
        { text: 'a', completed: true },
        { text: 'b', completed: false },
      ],
    })
    expect((todo[0] as { body: string }).body).toBe('- [x] a\n- [ ] b')
  })

  it('drops empty agent messages', () => {
    expect(mapThreadItem({ id: '5', type: 'agent_message', text: '' })).toEqual([])
  })
})
