import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSkillFrontmatter, scanContainer, scanLocal, scanTreeForSkills } from './scan'

// 扫描器行为测试：真实文件系统（mkdtemp），覆盖 frontmatter 形态、symlink、坏结构与远程树扫描。

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-scan-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function writeSkill(root: string, dir: string, name: string, content: string): string {
  const skillDir = path.join(root, dir, name)
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content)
  return skillDir
}

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# 正文\n`
}

describe('parseSkillFrontmatter', () => {
  it('提取顶层 name/description（含引号脱除与 CRLF）', () => {
    expect(parseSkillFrontmatter(frontmatter('foo', '做一件事'))).toEqual({ name: 'foo', description: '做一件事' })
    expect(parseSkillFrontmatter(`---\r\nname: 'bar'\r\ndescription: "desc"\r\n---\r\n`)).toEqual({
      name: 'bar',
      description: 'desc',
    })
  })

  it('折叠/块标量与空值视为缺失', () => {
    expect(parseSkillFrontmatter('---\nname: foo\ndescription: >\n  多行\n---\n')).toEqual({
      name: 'foo',
      description: '',
    })
    expect(parseSkillFrontmatter('---\nname:\ndescription: |\n  块\n---\n')).toEqual({ name: null, description: '' })
  })

  it('缩进的嵌套键不当作顶层字段', () => {
    const text = '---\nmetadata:\n  name: nested\ndescription: 顶层\n---\n'
    expect(parseSkillFrontmatter(text)).toEqual({ name: null, description: '顶层' })
  })

  it('无 frontmatter / 未闭合围栏 → 全缺失', () => {
    expect(parseSkillFrontmatter('# 只有正文\n')).toEqual({ name: null, description: '' })
    expect(parseSkillFrontmatter('---\nname: x\n')).toEqual({ name: null, description: '' })
  })
})

describe('scanContainer / scanLocal', () => {
  it('列出技能行：frontmatter name 优先，缺失回退目录名', () => {
    const root = makeRoot()
    writeSkill(root, '.agents/skills', 'alpha', frontmatter('Alpha 技能', '第一个'))
    writeSkill(root, '.agents/skills', 'beta', '---\ndescription: 无 name\n---\n')
    const entries = scanContainer(root, '.agents/skills')
    expect(entries.map((entry) => [entry.name, entry.dirName, entry.dir, entry.error])).toEqual([
      ['Alpha 技能', 'alpha', '.agents/skills', null],
      ['beta', 'beta', '.agents/skills', null],
    ])
    expect(entries[0]?.path).toBe(path.join(root, '.agents/skills', 'alpha'))
  })

  it('无 SKILL.md 的目录、普通文件与点开头条目一律跳过；容器缺失返回空', () => {
    const root = makeRoot()
    fs.mkdirSync(path.join(root, '.claude/skills', 'not-a-skill'), { recursive: true })
    fs.writeFileSync(path.join(root, '.claude/skills', 'stray.md'), 'x')
    fs.mkdirSync(path.join(root, '.claude/skills', '.hidden'), { recursive: true })
    expect(scanContainer(root, '.claude/skills')).toEqual([])
    expect(scanContainer(root, '.pi/skills')).toEqual([])
  })

  it('小写 skill.md 也能命中', () => {
    const root = makeRoot()
    const dir = path.join(root, '.pi/skills', 'lower')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'skill.md'), frontmatter('lower', 'x'))
    expect(scanContainer(root, '.pi/skills').map((entry) => entry.name)).toEqual(['lower'])
  })

  it('symlink 目录跟随扫描（各容器各报一行）；断链跳过', () => {
    const root = makeRoot()
    const real = writeSkill(root, '.agents/skills', 'linked', frontmatter('linked', '真实目录'))
    fs.mkdirSync(path.join(root, '.claude/skills'), { recursive: true })
    fs.symlinkSync(real, path.join(root, '.claude/skills', 'linked'))
    fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, '.claude/skills', 'broken'))

    const all = scanLocal(root)
    expect(all.map((entry) => [entry.dir, entry.dirName])).toEqual([
      ['.agents/skills', 'linked'],
      ['.claude/skills', 'linked'],
    ])
  })

  it('SKILL.md 读取失败仍出行并带 error（单个坏结构不炸列表）', () => {
    const root = makeRoot()
    // 名为 SKILL.md 的子目录：findSkillMd 命中但 readFile 必失败
    fs.mkdirSync(path.join(root, '.agents/skills', 'bad', 'SKILL.md'), { recursive: true })
    writeSkill(root, '.agents/skills', 'good', frontmatter('good', 'ok'))
    const entries = scanContainer(root, '.agents/skills')
    expect(entries).toHaveLength(2)
    expect(entries[0]?.dirName).toBe('bad')
    expect(entries[0]?.error).not.toBeNull()
    expect(entries[1]?.error).toBeNull()
  })
})

describe('scanTreeForSkills', () => {
  it('BFS 发现各层技能；跳过 node_modules 与点目录（技能容器除外）；命中即不深入', () => {
    const root = makeRoot()
    writeSkill(root, 'skills', 'foo', frontmatter('foo', '一'))
    writeSkill(root, path.join('skills', 'foo'), 'nested', frontmatter('nested', '不应出现'))
    writeSkill(root, '.claude/skills', 'bar', frontmatter('bar', '二'))
    writeSkill(root, 'node_modules', 'pkg', frontmatter('pkg', '不应出现'))
    writeSkill(root, '.git', 'obj', frontmatter('obj', '不应出现'))

    const found = scanTreeForSkills(root)
    expect(found.map((entry) => entry.relPath)).toEqual(['.claude/skills/bar', 'skills/foo'])
  })

  it('深度上限之外不再下探', () => {
    const root = makeRoot()
    writeSkill(root, 'a/b/c/d', 'deep', frontmatter('deep', '超深'))
    expect(scanTreeForSkills(root, 3)).toEqual([])
    expect(scanTreeForSkills(root, 5).map((entry) => entry.relPath)).toEqual(['a/b/c/d/deep'])
  })

  it('根自身即技能 → relPath 记 .', () => {
    const root = makeRoot()
    fs.writeFileSync(path.join(root, 'SKILL.md'), frontmatter('whole-repo', '整仓即技能'))
    const found = scanTreeForSkills(root)
    expect(found).toHaveLength(1)
    expect(found[0]?.relPath).toBe('.')
    expect(found[0]?.name).toBe('whole-repo')
  })
})
