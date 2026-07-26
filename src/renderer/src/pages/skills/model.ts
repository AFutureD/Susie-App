import type { TaskSkillRef } from '../../../../shared/config'
import { SKILL_DIRS, SKILL_SCOPES, type SkillDir, type SkillScope } from '../../../../shared/skills'

// 任务表单技能选择器的 option 值编码（<Select> 只吃字符串）：`scope|dir|dirName`。

export function encodeSkillOption(scope: SkillScope, dir: SkillDir, dirName: string): string {
  return `${scope}|${dir}|${dirName}`
}

/** 反解析；scope/dir 不合法或 dirName 为空返回 null */
export function decodeSkillOption(value: string): TaskSkillRef | null {
  const parts = value.split('|')
  const scope = parts[0]
  const dir = parts[1]
  const name = parts.slice(2).join('|')
  if (scope === undefined || dir === undefined || name === '') return null
  if (!(SKILL_SCOPES as readonly string[]).includes(scope)) return null
  if (!(SKILL_DIRS as readonly string[]).includes(dir)) return null
  return { name, dir: dir as SkillDir, scope: scope as SkillScope }
}
