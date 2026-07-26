import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantConfig } from '../../shared/config'
import type { ConfigStore } from '../config/store'
import type { Logger } from '../util/logger'
import { SkillsManager } from './manager'

// SkillsManager 行为测试：下载 mock 成本地固件拷贝（tar/zip 用系统工具现做），全程离线；
// 安装目标一律指向临时目录（scope=assistant + work_dir），绝不写用户主目录。

const download = vi.hoisted(() => ({ impl: null as ((url: string, dest: string) => void) | null }))

vi.mock('../agents/download', () => ({
  downloadWithProgress: async (url: string, dest: string): Promise<void> => {
    if (download.impl === null) throw new Error(`unexpected download: ${url}`)
    download.impl(url, dest)
  },
}))

const roots: string[] = []

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-skmgr-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  download.impl = null
  vi.unstubAllGlobals()
})

const noopLog: Logger = { info: () => {}, error: () => {} }

function makeManager(assistants: AssistantConfig[] = []): SkillsManager {
  const store = { current: { assistants } } as unknown as ConfigStore
  return new SkillsManager(store, noopLog)
}

/** 固件仓库 tarball：<top>/skills/daily/SKILL.md（codeload 形态：顶层唯一目录） */
function makeRepoTarball(): string {
  const base = makeRoot()
  const skillDir = path.join(base, 'repo-HEAD', 'skills', 'daily')
  fs.mkdirSync(skillDir, { recursive: true })
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: daily\ndescription: 日报\n---\n')
  const archive = path.join(base, 'repo.tar.gz')
  const result = spawnSync('tar', ['-czf', archive, '-C', base, 'repo-HEAD'], { stdio: 'pipe' })
  if (result.status !== 0) throw new Error(result.stderr.toString())
  return archive
}

function targetAssistant(): { assistant: AssistantConfig; workDir: string } {
  const workDir = makeRoot()
  return { assistant: { id: 'a1', agent_id: 'codex', work_dir: workDir }, workDir }
}

describe('listRepo / installFromRepo', () => {
  it('来源不可识别直接拒绝', async () => {
    const result = await makeManager().listRepo('???')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('仓库地址无法识别')
  })

  it('happy path：列出技能 → 安装 → 重复安装报 exists → 覆盖安装成功', async () => {
    const archive = makeRepoTarball()
    download.impl = (_url, dest) => fs.copyFileSync(archive, dest)
    const { assistant, workDir } = targetAssistant()
    const manager = makeManager([assistant])

    const listed = await manager.listRepo('owner/repo')
    expect(listed.ok).toBe(true)
    if (!listed.ok) return
    expect(listed.repoLabel).toBe('owner/repo')
    expect(listed.skills.map((skill) => [skill.name, skill.relPath])).toEqual([['daily', 'skills/daily']])

    const target = { scope: 'assistant' as const, assistantId: 'a1', dir: '.agents/skills' as const }
    const installed = manager.installFromRepo({
      sessionId: listed.sessionId,
      relPath: 'skills/daily',
      target,
      overwrite: false,
    })
    expect(installed).toEqual({ ok: true, path: path.join(workDir, '.agents/skills', 'daily') })
    expect(fs.existsSync(path.join(workDir, '.agents/skills', 'daily', 'SKILL.md'))).toBe(true)

    const again = manager.installFromRepo({
      sessionId: listed.sessionId,
      relPath: 'skills/daily',
      target,
      overwrite: false,
    })
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.exists).toBe(true)

    const overwritten = manager.installFromRepo({
      sessionId: listed.sessionId,
      relPath: 'skills/daily',
      target,
      overwrite: true,
    })
    expect(overwritten.ok).toBe(true)
  })

  it('relPath 越界与过期 session 拒绝', async () => {
    const archive = makeRepoTarball()
    download.impl = (_url, dest) => fs.copyFileSync(archive, dest)
    const manager = makeManager([targetAssistant().assistant])
    const listed = await manager.listRepo('owner/repo')
    if (!listed.ok) throw new Error('unexpected')

    const target = { scope: 'assistant' as const, assistantId: 'a1', dir: '.agents/skills' as const }
    const escape = manager.installFromRepo({
      sessionId: listed.sessionId,
      relPath: '../../x',
      target,
      overwrite: false,
    })
    expect(escape.ok).toBe(false)
    if (!escape.ok) expect(escape.message).toContain('越界')

    const stale = manager.installFromRepo({ sessionId: 'ghost', relPath: 'skills/daily', target, overwrite: false })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.message).toContain('已过期')
  })

  it('下载失败（HEAD/main/master 全 404）收敛为 ok:false', async () => {
    download.impl = () => {
      throw new Error('下载失败：HTTP 404')
    }
    const result = await makeManager().listRepo('owner/repo')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('下载仓库失败')
  })
})

describe('listLocal / listForAssistant / remove', () => {
  it('listForAssistant 按 agent 支持目录过滤（claude 不读 .agents/skills）', () => {
    const workDir = makeRoot()
    for (const [dir, name] of [
      ['.agents/skills', 'universal'],
      ['.claude/skills', 'claude-only'],
    ] as const) {
      const skillDir = path.join(workDir, dir, name)
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\n---\n`)
    }
    const manager = makeManager([
      { id: 'claude', agent_id: 'claude-acp', work_dir: workDir },
      { id: 'codex', agent_id: 'codex', work_dir: workDir },
    ])

    const claude = manager.listForAssistant('claude')
    expect(claude.dirs).toEqual(['.claude/skills'])
    expect(claude.workspace.map((skill) => skill.dirName)).toEqual(['claude-only'])

    const codex = manager.listForAssistant('codex')
    expect(codex.dirs).toEqual(['.agents/skills'])
    expect(codex.workspace.map((skill) => skill.dirName)).toEqual(['universal'])

    expect(() => manager.listForAssistant('ghost')).toThrow(/assistant 不存在/)
  })

  it('listLocal(assistant) 全量扫三容器；remove 删除并做名称白名单', () => {
    const { assistant, workDir } = targetAssistant()
    const skillDir = path.join(workDir, '.pi/skills', 'pi-skill')
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: pi-skill\n---\n')
    const manager = makeManager([assistant])

    const listed = manager.listLocal({ scope: 'assistant', assistantId: 'a1' })
    expect(listed.root).toBe(workDir)
    expect(listed.skills.map((skill) => [skill.dir, skill.dirName])).toEqual([['.pi/skills', 'pi-skill']])

    expect(
      manager.remove({ scope: 'assistant', assistantId: 'a1', dir: '.pi/skills', dirName: '../pi-skill' }).ok,
    ).toBe(false)
    expect(manager.remove({ scope: 'assistant', assistantId: 'a1', dir: '.pi/skills', dirName: 'ghost' }).ok).toBe(
      false,
    )
    expect(manager.remove({ scope: 'assistant', assistantId: 'a1', dir: '.pi/skills', dirName: 'pi-skill' })).toEqual({
      ok: true,
    })
    expect(fs.existsSync(skillDir)).toBe(false)
  })
})

describe('searchRegistry / installFromRegistry', () => {
  it('搜索：响应数组防御映射；非 2xx 收敛为 ok:false', async () => {
    const manager = makeManager()
    vi.stubGlobal('fetch', (async () => ({
      ok: true,
      status: 200,
      json: async () => [{ name: 'debt', version: '1.0.0' }, { bogus: true }, 'junk'],
    })) as unknown as typeof fetch)
    const found = await manager.searchRegistry('debt')
    expect(found.ok).toBe(true)
    if (found.ok) expect(found.skills.map((skill) => skill.name)).toEqual(['debt'])

    vi.stubGlobal('fetch', (async () => ({ ok: false, status: 502 })) as unknown as typeof fetch)
    const failed = await manager.searchRegistry('debt')
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.message).toContain('HTTP 502')
  })

  it('安装：取最新版本 → 下载 zip → 定位 SKILL.md → 落位并规范化大小写', async () => {
    // zip 固件：包内 lower/skill.md（小写），安装后应规范化为 SKILL.md
    const base = makeRoot()
    fs.mkdirSync(path.join(base, 'lower'), { recursive: true })
    fs.writeFileSync(path.join(base, 'lower', 'skill.md'), '---\nname: debt\n---\n')
    const archive = path.join(base, 'debt.zip')
    const zipped = spawnSync('zip', ['-r', '-q', archive, 'lower'], { cwd: base, stdio: 'pipe' })
    if (zipped.status !== 0) throw new Error(zipped.stderr.toString())

    download.impl = (_url, dest) => fs.copyFileSync(archive, dest)
    vi.stubGlobal('fetch', (async () => ({
      ok: true,
      status: 200,
      json: async () => [{ version: '1.0.0' }],
    })) as unknown as typeof fetch)
    const { assistant, workDir } = targetAssistant()
    const manager = makeManager([assistant])

    const result = await manager.installFromRegistry({
      name: 'debt',
      target: { scope: 'assistant', assistantId: 'a1', dir: '.agents/skills' },
      overwrite: false,
    })
    expect(result).toEqual({ ok: true, path: path.join(workDir, '.agents/skills', 'debt') })
    expect(fs.readdirSync(path.join(workDir, '.agents/skills', 'debt'))).toEqual(['SKILL.md'])
  })

  it('非法技能名拒绝', async () => {
    const result = await makeManager().installFromRegistry({
      name: '../evil',
      target: { scope: 'global', dir: '.agents/skills' },
      overwrite: false,
    })
    expect(result.ok).toBe(false)
  })
})
