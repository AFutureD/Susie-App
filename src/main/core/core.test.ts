import { describe, expect, it } from 'vitest'
import type { ChatBinding } from '../../shared/config'
import { resolveBinding } from './chat-manager'
import { CommandRegistry, parseCommandText, type CommandContext } from './commands'

describe('parseCommandText', () => {
  it('parses name, args and strips @botname', () => {
    expect(parseCommandText('/help')).toEqual({ name: 'help', args: [] })
    expect(parseCommandText('/model gpt-5.2')).toEqual({ name: 'model', args: ['gpt-5.2'] })
    expect(parseCommandText('/help@my_bot now')).toEqual({ name: 'help', args: ['now'] })
    expect(parseCommandText('hello')).toBeNull()
    expect(parseCommandText('/')).toBeNull()
  })
})

const makeCtx = (replies: string[]): CommandContext => ({
  channelId: 'c',
  chatId: 'x',
  reply: (text) => {
    replies.push(text)
    return Promise.resolve()
  },
})

describe('CommandRegistry', () => {
  it('executes commands, inherits from parent, and lists help', async () => {
    const parent = new CommandRegistry()
    const child = new CommandRegistry(parent)
    child.register({ name: 'new', description: 'new session', handler: () => 'ok' })

    const replies: string[] = []
    expect(await child.execute(makeCtx(replies), 'new', [])).toBe(true)
    expect(replies).toEqual(['ok'])

    expect(await child.execute(makeCtx(replies), 'help', [])).toBe(true)
    expect(replies[1]).toContain('/help')

    // 未注册命令 → false，交回 assistant
    expect(await child.execute(makeCtx(replies), 'unknown', [])).toBe(false)
  })

  it('reports handler errors as replies instead of throwing', async () => {
    const registry = new CommandRegistry()
    registry.register({
      name: 'boom',
      description: '',
      handler: () => {
        throw new Error('nope')
      },
    })
    const replies: string[] = []
    expect(await registry.execute(makeCtx(replies), 'boom', [])).toBe(true)
    expect(replies[0]).toContain('nope')
  })
})

describe('resolveBinding', () => {
  const bindings: ChatBinding[] = [
    { channel: 'a', chat_ids: ['P:1'], assistant_id: 'ops' },
    { channel: 'a', chat_ids: ['*'], assistant_id: 'default' },
    { channel: 'b', chat_ids: ['*'], assistant_id: 'other' },
  ]

  it('matches exact chat id or wildcard in declaration order', () => {
    expect(resolveBinding(bindings, 'a', 'P:1').assistant_id).toBe('ops')
    expect(resolveBinding(bindings, 'a', 'P:2').assistant_id).toBe('default')
    expect(resolveBinding(bindings, 'b', 'G:9').assistant_id).toBe('other')
  })

  it('falls back to the default assistant when nothing matches', () => {
    expect(resolveBinding(bindings, 'zzz', 'P:1').assistant_id).toBe('default')
  })
})
