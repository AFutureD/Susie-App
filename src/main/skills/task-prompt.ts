import os from 'node:os'
import path from 'node:path'
import type { AssistantConfig, ScheduledTask } from '../../shared/config'
import { skillDirsForAgent } from '../../shared/skills'
import { getWorkspaceDir } from '../config/paths'
import { findSkillMd } from './scan'

/**
 * 定时任务的 prompt 渲染：无 skill 原样返回 content；有 skill 现场解析路径并拼通用指引——
 * ACP 无原生技能输入协议，「阅读 SKILL.md 并遵循」对全部 agent 一致有效。
 * 解析失败抛错，由调度器收敛为 error 执行记录（与 assistant 缺失同型）。
 */
export function renderTaskPrompt(task: ScheduledTask, assistant: AssistantConfig, home = os.homedir()): string {
  const skill = task.skill
  if (skill === undefined) return task.content

  if (!skillDirsForAgent(assistant.agent_id).includes(skill.dir)) {
    throw new Error(`助手的 agent（${assistant.agent_id}）不支持技能目录 ${skill.dir}`)
  }
  const root = skill.scope === 'global' ? home : (assistant.work_dir ?? getWorkspaceDir(assistant.id))
  const skillDir = path.join(root, skill.dir, skill.name)
  const skillMd = findSkillMd(skillDir)
  if (skillMd === null) throw new Error(`skill 不存在：${skillDir}`)

  const lines = [`使用 skill「${skill.name}」执行本次任务：先完整阅读 ${skillMd}，再严格按照其中的指引执行。`]
  const extra = task.content.trim()
  if (extra !== '') lines.push('', '补充输入：', extra)
  return lines.join('\n')
}
