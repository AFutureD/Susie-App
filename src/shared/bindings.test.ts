import { describe, expect, it } from 'vitest'
import {
  canonicalizeBindings,
  expandBindings,
  isTriggerSatisfied,
  resolveEffectiveBinding,
  type BindingAssignments,
} from './bindings'
import type { ChatBinding } from './config'

const bind = (
  channel: string,
  chatId: string,
  assistantId: string | undefined,
  extra: Partial<ChatBinding> = {},
): ChatBinding => ({
  channel,
  chat_id: chatId,
  assistant_id: assistantId,
  respond: true,
  only_mention: true,
  send_output: false,
  ...extra,
})

describe('expandBindings', () => {
  it('splits exact entries and the per-channel default, keeping trigger attributes', () => {
    const bindings = [bind('a', 'S:-1', 'ops', { only_mention: false, send_output: true }), bind('a', '*', 'default')]
    expect(expandBindings(bindings)).toEqual({
      exact: { a: { 'S:-1': { assistantId: 'ops', respond: true, onlyMention: false, sendOutput: true } } },
      wildcard: { a: { assistantId: 'default', respond: true, onlyMention: true, sendOutput: false } },
    })
  })

  it('keeps the first declaration on duplicates (legacy tolerance)', () => {
    const bindings = [bind('a', 'P:1', 'first'), bind('a', 'P:1', 'second'), bind('a', '*', 'w1'), bind('a', '*', 'w2')]
    const expanded = expandBindings(bindings)
    expect(expanded.exact['a']?.['P:1']?.assistantId).toBe('first')
    expect(expanded.wildcard['a']?.assistantId).toBe('w1')
  })

  it('maps a follow-default exact binding to assistantId null and keeps respond', () => {
    const expanded = expandBindings([bind('a', 'P:1', undefined, { respond: false })])
    expect(expanded.exact['a']?.['P:1']).toEqual({
      assistantId: null,
      respond: false,
      onlyMention: true,
      sendOutput: false,
    })
  })
})

describe('canonicalizeBindings', () => {
  it('emits one entry per chat, sorted, with the channel default last', () => {
    const assignments: BindingAssignments = {
      exact: {
        b: { 'P:9': { assistantId: 'ops', respond: true, onlyMention: true, sendOutput: false } },
        a: {
          'P:2': { assistantId: 'ops', respond: true, onlyMention: true, sendOutput: false },
          'G:1': { assistantId: 'other', respond: true, onlyMention: false, sendOutput: true },
        },
      },
      wildcard: { a: { assistantId: 'default', respond: false, onlyMention: true, sendOutput: false } },
    }
    expect(canonicalizeBindings(assignments)).toEqual([
      bind('a', 'G:1', 'other', { only_mention: false, send_output: true }),
      bind('a', 'P:2', 'ops'),
      bind('a', '*', 'default', { respond: false }),
      bind('b', 'P:9', 'ops'),
    ])
  })

  it('omits assistant_id for follow-default exact assignments', () => {
    const assignments: BindingAssignments = {
      exact: { a: { 'P:1': { assistantId: null, respond: true, onlyMention: true, sendOutput: false } } },
      wildcard: {},
    }
    const [binding] = canonicalizeBindings(assignments)
    expect(binding?.assistant_id).toBeUndefined()
  })

  it('round-trips: expand(canonicalize(expand(x))) equals expand(x)', () => {
    const legacy = [
      bind('b', '*', 'x', { respond: false }),
      bind('a', 'P:1', undefined),
      bind('a', 'P:1', 'dup'),
      bind('a', '*', 'w'),
    ]
    const expanded = expandBindings(legacy)
    expect(expandBindings(canonicalizeBindings(expanded))).toEqual(expanded)
  })
})

describe('resolveEffectiveBinding', () => {
  const bindings = [bind('a', 'P:1', 'ops'), bind('a', '*', 'fallback'), bind('b', 'G:2', 'other')]

  it('prefers exact over the channel default, independent of order', () => {
    expect(resolveEffectiveBinding(bindings, 'a', 'P:1')?.assistantId).toBe('ops')
    expect(resolveEffectiveBinding(bindings, 'a', 'P:9')?.assistantId).toBe('fallback')
    const reversed = [bind('a', '*', 'fallback'), bind('a', 'P:1', 'ops')]
    expect(resolveEffectiveBinding(reversed, 'a', 'P:1')?.assistantId).toBe('ops')
  })

  it('returns null (无路由) when nothing matches — no global fallback', () => {
    expect(resolveEffectiveBinding(bindings, 'b', 'P:1')).toBeNull()
    expect(resolveEffectiveBinding(bindings, 'zzz', 'P:1')).toBeNull()
    expect(resolveEffectiveBinding([], 'a', 'P:1')).toBeNull()
  })

  it('does not treat a literal "*" chatId as an exact match', () => {
    expect(resolveEffectiveBinding(bindings, 'a', '*')?.assistantId).toBe('fallback')
  })

  it('borrows only the assistant from the channel default, not the options', () => {
    const mixed = [
      bind('a', 'P:1', undefined, { respond: true, only_mention: false, send_output: true }),
      bind('a', '*', 'fallback', { respond: false, only_mention: true, send_output: false }),
    ]
    expect(resolveEffectiveBinding(mixed, 'a', 'P:1')).toEqual({
      assistantId: 'fallback',
      respond: true,
      onlyMention: false,
      sendOutput: true,
    })
  })

  it('resolves assistantId to null when a follow-default exact has no channel default', () => {
    const orphan = [bind('a', 'P:1', undefined)]
    expect(resolveEffectiveBinding(orphan, 'a', 'P:1')).toEqual({
      assistantId: null,
      respond: true,
      onlyMention: true,
      sendOutput: false,
    })
  })

  it('lets an exact respond=false mute a chat while the channel default responds', () => {
    const mixed = [bind('a', 'P:1', 'ops', { respond: false }), bind('a', '*', 'fallback')]
    expect(resolveEffectiveBinding(mixed, 'a', 'P:1')?.respond).toBe(false)
    expect(resolveEffectiveBinding(mixed, 'a', 'P:9')?.respond).toBe(true)
  })

  it('lets an exact respond=true opt in while the channel default is muted', () => {
    const mixed = [bind('a', 'P:1', undefined), bind('a', '*', 'fallback', { respond: false })]
    expect(resolveEffectiveBinding(mixed, 'a', 'P:1')).toEqual({
      assistantId: 'fallback',
      respond: true,
      onlyMention: true,
      sendOutput: false,
    })
    expect(resolveEffectiveBinding(mixed, 'a', 'P:9')?.respond).toBe(false)
  })
})

describe('isTriggerSatisfied', () => {
  it('always triggers in private chats', () => {
    expect(isTriggerSatisfied(true, { chatType: 'private', mentioned: false })).toBe(true)
  })

  it('requires mention in groups when only_mention is set', () => {
    expect(isTriggerSatisfied(true, { chatType: 'supergroup', mentioned: false })).toBe(false)
    expect(isTriggerSatisfied(true, { chatType: 'supergroup', mentioned: true })).toBe(true)
  })

  it('triggers freely in groups when only_mention is off', () => {
    expect(isTriggerSatisfied(false, { chatType: 'group', mentioned: false })).toBe(true)
  })
})
