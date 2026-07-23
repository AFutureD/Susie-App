import { describe, expect, it } from 'vitest'
import {
  canonicalizeBindings,
  expandBindings,
  isSenderAdmitted,
  resolveBinding,
  type BindingAssignments,
} from './bindings'
import type { ChatBinding } from './config'

const bind = (channel: string, chatId: string, assistantId: string, extra: Partial<ChatBinding> = {}): ChatBinding => ({
  channel,
  chat_id: chatId,
  assistant_id: assistantId,
  only_mention: true,
  members: [],
  ...extra,
})

describe('expandBindings', () => {
  it('splits exact entries and the per-channel default, keeping trigger attributes', () => {
    const bindings = [bind('a', 'S:-1', 'ops', { only_mention: false, members: ['7'] }), bind('a', '*', 'default')]
    expect(expandBindings(bindings)).toEqual({
      exact: { a: { 'S:-1': { assistantId: 'ops', onlyMention: false, members: ['7'] } } },
      wildcard: { a: { assistantId: 'default', onlyMention: true, members: [] } },
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
        b: { 'P:9': { assistantId: 'ops', onlyMention: true, members: [] } },
        a: {
          'P:2': { assistantId: 'ops', onlyMention: true, members: [] },
          'G:1': { assistantId: 'other', onlyMention: false, members: ['5'] },
        },
      },
      wildcard: { a: { assistantId: 'default', onlyMention: true, members: [] } },
    }
    expect(canonicalizeBindings(assignments)).toEqual([
      bind('a', 'G:1', 'other', { only_mention: false, members: ['5'] }),
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

  it('returns null (禁止) when nothing matches — no global fallback', () => {
    expect(resolveBinding(bindings, 'b', 'P:1')).toBeNull()
    expect(resolveBinding(bindings, 'zzz', 'P:1')).toBeNull()
    expect(resolveBinding([], 'a', 'P:1')).toBeNull()
  })

  it('does not treat a literal "*" chatId as an exact match', () => {
    expect(resolveBinding(bindings, 'a', '*')?.assistant_id).toBe('fallback')
  })
})

describe('isSenderAdmitted', () => {
  it('always admits private chats (chat granularity already covers the user)', () => {
    const binding = bind('a', 'P:1', 'ops', { only_mention: true, members: ['999'] })
    expect(isSenderAdmitted(binding, { chatType: 'private', senderId: '1', mentioned: false })).toBe(true)
  })

  it('requires mention in groups when only_mention is set', () => {
    const binding = bind('a', 'S:-1', 'ops')
    expect(isSenderAdmitted(binding, { chatType: 'supergroup', senderId: '1', mentioned: false })).toBe(false)
    expect(isSenderAdmitted(binding, { chatType: 'supergroup', senderId: '1', mentioned: true })).toBe(true)
  })

  it('filters group senders by the member list; empty list admits everyone', () => {
    const restricted = bind('a', 'S:-1', 'ops', { only_mention: false, members: ['7'] })
    expect(isSenderAdmitted(restricted, { chatType: 'group', senderId: '7', mentioned: false })).toBe(true)
    expect(isSenderAdmitted(restricted, { chatType: 'group', senderId: '8', mentioned: false })).toBe(false)
    expect(isSenderAdmitted(restricted, { chatType: 'group', senderId: null, mentioned: false })).toBe(false)

    const open = bind('a', 'S:-1', 'ops', { only_mention: false })
    expect(isSenderAdmitted(open, { chatType: 'group', senderId: '8', mentioned: false })).toBe(true)
  })
})
