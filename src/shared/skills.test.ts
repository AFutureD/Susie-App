import { describe, expect, it } from 'vitest'
import { filterSkills, skillDirsForAgent } from './skills'

describe('skillDirsForAgent', () => {
  // 判定表对齐 vercel-labs/skills Supported agents（project 列）∩ 三容器目录
  it.each([
    ['claude-acp', ['.claude/skills']],
    ['pi-acp', ['.pi/skills']],
    ['codex', ['.agents/skills']],
    ['codex-acp', ['.agents/skills']],
    ['gemini', ['.agents/skills']],
    ['opencode', ['.agents/skills']],
    ['github-copilot-cli', ['.agents/skills']],
  ] as const)('%s → %j', (agentId, dirs) => {
    expect(skillDirsForAgent(agentId)).toEqual(dirs)
  })

  it.each(['goose', 'qwen-code', 'devin', 'junie', 'kilo', 'grok-build'])(
    '目录超出 v1 支持范围的 agent 置空：%s',
    (agentId) => {
      expect(skillDirsForAgent(agentId)).toEqual([])
    },
  )

  it('未收录 id 走 Universal（.agents/skills）', () => {
    expect(skillDirsForAgent('some-future-agent')).toEqual(['.agents/skills'])
    expect(skillDirsForAgent('copilot')).toEqual(['.agents/skills'])
  })
})

describe('filterSkills', () => {
  const entries = [
    { name: 'Task Management', dirName: 'task-management', description: '组织任务文档' },
    { name: 'find-skills', dirName: 'find-skills', description: 'Discover and install agent skills' },
    { name: 'adhd', dirName: 'i-have-adhd', description: 'Shape output for ADHD readers' },
  ]

  it('空白查询返回全量', () => {
    expect(filterSkills(entries, '')).toEqual(entries)
    expect(filterSkills(entries, '   ')).toEqual(entries)
  })

  it('name 不区分大小写匹配', () => {
    expect(filterSkills(entries, 'task man').map((e) => e.dirName)).toEqual(['task-management'])
  })

  it('dirName 匹配', () => {
    expect(filterSkills(entries, 'i-have').map((e) => e.dirName)).toEqual(['i-have-adhd'])
  })

  it('description 匹配', () => {
    expect(filterSkills(entries, 'DISCOVER').map((e) => e.dirName)).toEqual(['find-skills'])
  })

  it('无匹配返回空', () => {
    expect(filterSkills(entries, 'nonexistent')).toEqual([])
  })
})
