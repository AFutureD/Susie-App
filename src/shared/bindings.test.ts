import { describe, expect, it } from 'vitest'
import {
  canonicalizeBindings,
  expandBindings,
  isTriggerSatisfied,
  resolveBinding,
  type BindingAssignments,
} from './bindings'
import type { ChatBinding } from './config'

const bind = (channel: string, chatId: string, assistantId: string, extra: Partial<ChatBinding> = {}): ChatBinding => ({
  channel,
  chat_id: chatId,
  assistant_id: assistantId,
  only_mention: true,
  send_output: false,
  ...extra,
})

describe('expandBindings', () => {
  it('splits exact entries and the per-channel default, keeping trigger attributes', () => {
    const bindings = [bind('a', 'S:-1', 'ops', { only_mention: false, send_output: true }), bind('a', '*', 'default')]
    expect(expandBindings(bindings)).toEqual({
      exact: { a: { 'S:-1': { assistantId: 'ops', onlyMention: false, sendOutput: true } } },
      wildcard: { a: { assistantId: 'default', onlyMention: true, sendOutput: false } },
    })
  })

  it('keeps the first declaration on duplicates (legacy tolerance)', () => {
    const bindings = [bind('a', 'P:1', 'first'), bind('a', 'P:1', 'second'), bind('a', '*', 'w1'), bind('a', '*', 'w2')]
    const expanded = expandBindings(bindings)
    expect(expanded.exact['a']?.['P:1']?.assistantId).toBe('first')
    expect(expanded.wildcard['a']?.assistantId).toBe('w1')
  })
})

describe('canonicalizeBindings', () => {
  it('emits one entry per chat, sorted, with the channel default last', () => {
    const assignments: BindingAssignments = {
      exact: {
        b: { 'P:9': { assistantId: 'ops', onlyMention: true, sendOutput: false } },
        a: {
          'P:2': { assistantId: 'ops', onlyMention: true, sendOutput: false },
          'G:1': { assistantId: 'other', onlyMention: false, sendOutput: true },
        },
      },
      wildcard: { a: { assistantId: 'default', onlyMention: true, sendOutput: false } },
    }
    expect(canonicalizeBindings(assignments)).toEqual([
      bind('a', 'G:1', 'other', { only_mention: false, send_output: true }),
      bind('a', 'P:2', 'ops'),
      bind('a', '*', 'default'),
      bind('b', 'P:9', 'ops'),
    ])
  })

  it('round-trips: expand(canonicalize(expand(x))) equals expand(x)', () => {
    const legacy = [bind('b', '*', 'x'), bind('a', 'P:1', 'ops'), bind('a', 'P:1', 'dup'), bind('a', '*', 'w')]
    const expanded = expandBindings(legacy)
    expect(expandBindings(canonicalizeBindings(expanded))).toEqual(expanded)
  })
})

describe('resolveBinding', () => {
  const bindings = [bind('a', 'P:1', 'ops'), bind('a', '*', 'fallback'), bind('b', 'G:2', 'other')]

  it('prefers exact over the channel default, independent of order', () => {
    expect(resolveBinding(bindings, 'a', 'P:1')?.assistant_id).toBe('ops')
    expect(resolveBinding(bindings, 'a', 'P:9')?.assistant_id).toBe('fallback')
    const reversed = [bind('a', '*', 'fallback'), bind('a', 'P:1', 'ops')]
    expect(resolveBinding(reversed, 'a', 'P:1')?.assistant_id).toBe('ops')
  })

  it('returns null (无路由) when nothing matches — no global fallback', () => {
    expect(resolveBinding(bindings, 'b', 'P:1')).toBeNull()
    expect(resolveBinding(bindings, 'zzz', 'P:1')).toBeNull()
    expect(resolveBinding([], 'a', 'P:1')).toBeNull()
  })

  it('does not treat a literal "*" chatId as an exact match', () => {
    expect(resolveBinding(bindings, 'a', '*')?.assistant_id).toBe('fallback')
  })
})

describe('isTriggerSatisfied', () => {
  it('always triggers in private chats', () => {
    const binding = bind('a', 'P:1', 'ops', { only_mention: true })
    expect(isTriggerSatisfied(binding, { chatType: 'private', mentioned: false })).toBe(true)
  })

  it('requires mention in groups when only_mention is set', () => {
    const binding = bind('a', 'S:-1', 'ops')
    expect(isTriggerSatisfied(binding, { chatType: 'supergroup', mentioned: false })).toBe(false)
    expect(isTriggerSatisfied(binding, { chatType: 'supergroup', mentioned: true })).toBe(true)
  })

  it('triggers freely in groups when only_mention is off', () => {
    const binding = bind('a', 'S:-1', 'ops', { only_mention: false })
    expect(isTriggerSatisfied(binding, { chatType: 'group', mentioned: false })).toBe(true)
  })
})
