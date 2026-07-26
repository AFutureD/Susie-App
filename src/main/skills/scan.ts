import fs from 'node:fs'
import path from 'node:path'
import { errorMessage } from '../../shared/errors'
import { SKILL_DIRS, type RemoteSkillEntry, type SkillDir, type SkillEntry } from '../../shared/skills'

// 本地技能扫描：skill = 容器目录的直接子目录且含 SKILL.md。
// 只读操作（绝不创建目录）；跟随 symlink（等同文件管理器视角），不记录链接细节。

/** 从 SKILL.md 文本提取 frontmatter 顶层 name/description（仅展示用，极简解析不引 yaml 依赖） */
export function parseSkillFrontmatter(text: string): { name: string | null; description: string } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  let start = 0
  while (start < lines.length && lines[start]?.trim() === '') start += 1
  if (lines[start]?.trim() !== '---') return { name: null, description: '' }
  let end = -1
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { name: null, description: '' }

  let name: string | null = null
  let description = ''
  for (let i = start + 1; i < end; i += 1) {
    const match = /^(name|description):\s*(.*)$/.exec(lines[i] ?? '')
    if (match === null) continue
    const value = unquote((match[2] ?? '').trim())
    // 空值与块/折叠标量（>、|）视为缺失——多行标量对列表展示无意义
    if (value === '' || value.startsWith('>') || value.startsWith('|')) continue
    if (match[1] === 'name') name = value
    else description = value
  }
  return { name, description }
}

function unquote(value: string): string {
  const quoted =
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
  return quoted ? value.slice(1, -1) : value
}

/** 在目录中定位 SKILL.md（大小写不敏感，精确大写优先；社区存在小写 skill.md） */
export function findSkillMd(dirAbs: string): string | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(dirAbs)
  } catch {
    return null
  }
  if (entries.includes('SKILL.md')) return path.join(dirAbs, 'SKILL.md')
  const alt = entries.find((entry) => entry.toLowerCase() === 'skill.md')
  return alt === undefined ? null : path.join(dirAbs, alt)
}

/** 扫描单个容器目录；容器不存在返回空 */
export function scanContainer(root: string, dir: SkillDir): SkillEntry[] {
  const containerAbs = path.join(root, dir)
  let names: string[]
  try {
    names = fs.readdirSync(containerAbs).sort()
  } catch {
    return []
  }
  const entries: SkillEntry[] = []
  for (const dirName of names) {
    if (dirName.startsWith('.')) continue
    const entry = readSkillEntry(containerAbs, dir, dirName)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

function readSkillEntry(containerAbs: string, dir: SkillDir, dirName: string): SkillEntry | null {
  const skillPath = path.join(containerAbs, dirName)
  let stat: fs.Stats
  try {
    stat = fs.statSync(skillPath) // 跟随 symlink；断链抛 ENOENT → 跳过
  } catch {
    return null
  }
  if (!stat.isDirectory()) return null
  const skillMd = findSkillMd(skillPath)
  if (skillMd === null) return null // 不含 SKILL.md 的目录不是技能，静默跳过

  try {
    const parsed = parseSkillFrontmatter(fs.readFileSync(skillMd, 'utf-8'))
    return { name: parsed.name ?? dirName, description: parsed.description, dirName, dir, path: skillPath, error: null }
  } catch (error) {
    // 单个坏文件不炸整个列表：仍出行供定位/删除
    return { name: dirName, description: '', dirName, dir, path: skillPath, error: errorMessage(error) }
  }
}

/** 依次扫描三个容器目录 */
export function scanLocal(root: string): SkillEntry[] {
  return SKILL_DIRS.flatMap((dir) => scanContainer(root, dir))
}

/** 点目录中允许进入的技能容器首段（.agents/.claude/.pi） */
const CONTAINER_ROOTS = new Set(SKILL_DIRS.map((dir) => dir.split('/')[0] ?? ''))

/**
 * 远程仓库解包树扫描：BFS，命中含 SKILL.md 的目录即记为技能且不再深入；
 * 跳过 node_modules 与点目录（技能容器 .agents/.claude/.pi 除外）。
 * 根自身含 SKILL.md（整仓即单技能）时 relPath 记 '.'，dirName 由调用方按仓库名改写。
 */
export function scanTreeForSkills(rootAbs: string, maxDepth = 4): RemoteSkillEntry[] {
  const found: RemoteSkillEntry[] = []
  const queue: Array<{ abs: string; rel: string; depth: number }> = [{ abs: rootAbs, rel: '', depth: 0 }]
  while (queue.length > 0) {
    const node = queue.shift()
    if (node === undefined) break
    const skillMd = findSkillMd(node.abs)
    if (skillMd !== null) {
      const dirName = path.basename(node.abs)
      let name = dirName
      let description = ''
      try {
        const parsed = parseSkillFrontmatter(fs.readFileSync(skillMd, 'utf-8'))
        name = parsed.name ?? dirName
        description = parsed.description
      } catch {
        // 解析失败回退目录名
      }
      found.push({ name, description, dirName, relPath: node.rel === '' ? '.' : node.rel })
      continue
    }
    if (node.depth >= maxDepth) continue
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(node.abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      if (child.name === 'node_modules') continue
      if (child.name.startsWith('.') && !CONTAINER_ROOTS.has(child.name)) continue
      queue.push({
        abs: path.join(node.abs, child.name),
        rel: node.rel === '' ? child.name : `${node.rel}/${child.name}`,
        depth: node.depth + 1,
      })
    }
  }
  return found.sort((a, b) => a.relPath.localeCompare(b.relPath))
}
