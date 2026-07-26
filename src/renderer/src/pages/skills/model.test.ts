import { describe, expect, it } from 'vitest'
import { decodeSkillOption, encodeSkillOption } from './model'

describe('skill option 编码', () => {
  it('encode ⇄ decode 往返', () => {
    const value = encodeSkillOption('assistant', '.claude/skills', 'task-management')
    expect(value).toBe('assistant|.claude/skills|task-management')
    expect(decodeSkillOption(value)).toEqual({
      name: 'task-management',
      dir: '.claude/skills',
      scope: 'assistant',
    })
  })

  it('目录名含分隔符时余段并回 name', () => {
    expect(decodeSkillOption('global|.agents/skills|a|b')).toEqual({
      name: 'a|b',
      dir: '.agents/skills',
      scope: 'global',
    })
  })

  it.each(['', 'x', 'global|.agents/skills|', 'nope|.agents/skills|a', 'global|.codex/skills|a'])(
    '非法串 %s 返回 null',
    (value) => {
      expect(decodeSkillOption(value)).toBeNull()
    },
  )
})
