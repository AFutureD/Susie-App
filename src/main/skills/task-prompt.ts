import os from 'node:os'
import path from 'node:path'
import type { AssistantConfig, ScheduledTask } from '../../shared/config'
import { skillDirsForAgent } from '../../shared/skills'
import { getWorkspaceDir } from '../config/paths'
import { findSkillMd } from './scan'

/**
 * 定时任务的 prompt 渲染：无 skill 原样返回 content；有 skill（技能目录名）按
 * 「工作目录优先于全局 × agent 支持的容器目录」现场按名解析，拼通用指引——
 * ACP 无原生技能输入协议，「阅读 SKILL.md 并遵循」对全部 agent 一致有效。
 * 解析失败抛错，由调度器收敛为 error 执行记录（与 assistant 缺失同型）。
 */
export function renderTaskPrompt(task: ScheduledTask, assistant: AssistantConfig, home = os.homedir()): string {
  const skillName = task.skill
  if (skillName === undefined) return task.content

  const dirs = skillDirsForAgent(assistant.agent_id)
  if (dirs.length === 0) {
    throw new Error(`助手的 agent（${assistant.agent_id}）不支持技能`)
  }

  const workRoot = assistant.work_dir ?? getWorkspaceDir(assistant.id)
  const candidates = [workRoot, home].flatMap((root) => dirs.map((dir) => path.join(root, dir, skillName)))
  const skillMd = candidates.map(findSkillMd).find((found) => found !== null) ?? null
  if (skillMd === null) throw new Error(`skill 不存在：${skillName}（已查找 ${candidates.join('、')}）`)

  const lines = [`使用 skill「${skillName}」执行本次任务：先完整阅读 ${skillMd}，再严格按照其中的指引执行。`]
  const extra = task.content.trim()
  if (extra !== '') lines.push('', '补充输入：', extra)
  return lines.join('\n')
}
