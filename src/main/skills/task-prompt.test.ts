import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AssistantConfig, ScheduledTask } from '../../shared/config'
import { renderTaskPrompt } from './task-prompt'

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-prompt-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  delete process.env['SUSIE_CONFIG_DIR']
})

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 't1',
    name: '技能任务',
    content: '',
    assistant_id: 'a1',
    schedule: '* * * * *',
    targets: [{ channel: 'tg', chat_id: 'P:1' }],
    enabled: true,
    ...overrides,
  }
}

function makeAssistant(overrides: Partial<AssistantConfig> = {}): AssistantConfig {
  return { id: 'a1', agent_id: 'codex', ...overrides }
}

function writeSkillMd(root: string, dir: string, name: string): string {
  const skillDir = path.join(root, dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  const skillMd = path.join(skillDir, 'SKILL.md')
  fs.writeFileSync(skillMd, `---\nname: ${name}\n---\n`)
  return skillMd
}

describe('renderTaskPrompt', () => {
  it('无 skill：content 原样透传', () => {
    const task = makeTask({ content: '汇总昨天的要点' })
    expect(renderTaskPrompt(task, makeAssistant())).toBe('汇总昨天的要点')
  })

  it('按名解析到 work_dir 下的技能；空 content 不带补充输入', () => {
    const workDir = makeRoot()
    const skillMd = writeSkillMd(workDir, '.agents/skills', 'daily')
    const task = makeTask({ skill: 'daily' })
    const prompt = renderTaskPrompt(task, makeAssistant({ work_dir: workDir }), makeRoot())
    expect(prompt).toContain(`先完整阅读 ${skillMd}`)
    expect(prompt).toContain('skill「daily」')
    expect(prompt).not.toContain('补充输入')
  })

  it('工作目录没有时回退全局（注入的 home）；补充输入拼接在后', () => {
    const home = makeRoot()
    const skillMd = writeSkillMd(home, '.claude/skills', 'report')
    const task = makeTask({ content: '  只看上周数据  ', skill: 'report' })
    const prompt = renderTaskPrompt(task, makeAssistant({ agent_id: 'claude-acp', work_dir: makeRoot() }), home)
    expect(prompt).toContain(skillMd)
    expect(prompt).toMatch(/补充输入：\n只看上周数据$/)
  })

  it('同名技能工作目录优先于全局', () => {
    const workDir = makeRoot()
    const home = makeRoot()
    const workSkillMd = writeSkillMd(workDir, '.agents/skills', 'daily')
    writeSkillMd(home, '.agents/skills', 'daily')
    const task = makeTask({ skill: 'daily' })
    expect(renderTaskPrompt(task, makeAssistant({ work_dir: workDir }), home)).toContain(workSkillMd)
  })

  it('work_dir 未设时回退 workspace/<id>（SUSIE_CONFIG_DIR 注入）', () => {
    const configDir = makeRoot()
    process.env['SUSIE_CONFIG_DIR'] = configDir
    const workspace = path.join(configDir, 'workspace', 'a1')
    const skillMd = writeSkillMd(workspace, '.agents/skills', 'daily')
    const task = makeTask({ skill: 'daily' })
    expect(renderTaskPrompt(task, makeAssistant(), makeRoot())).toContain(skillMd)
  })

  it('agent 的技能目录不在支持范围（goose）→ 抛错', () => {
    const task = makeTask({ skill: 'daily' })
    expect(() =>
      renderTaskPrompt(task, makeAssistant({ agent_id: 'goose', work_dir: makeRoot() }), makeRoot()),
    ).toThrow(/不支持技能/)
  })

  it('agent 不读该容器目录 → 视为不存在（claude 不读 .agents/skills）', () => {
    const workDir = makeRoot()
    writeSkillMd(workDir, '.agents/skills', 'daily')
    const task = makeTask({ skill: 'daily' })
    expect(() =>
      renderTaskPrompt(task, makeAssistant({ agent_id: 'claude-acp', work_dir: workDir }), makeRoot()),
    ).toThrow(/skill 不存在/)
  })

  it('skill 缺失 → 抛错并列出查找路径', () => {
    const workDir = makeRoot()
    const home = makeRoot()
    const task = makeTask({ skill: 'ghost' })
    expect(() => renderTaskPrompt(task, makeAssistant({ work_dir: workDir }), home)).toThrow(/skill 不存在：ghost/)
  })
})
