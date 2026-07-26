import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AssistantConfig } from '../../shared/config'
import { errorMessage } from '../../shared/errors'
import type { ActionResult } from '../../shared/ipc/contract'
import {
  skillDirsForAgent,
  type AssistantSkills,
  type LocalSkillList,
  type RegistrySearchResult,
  type RegistrySkillEntry,
  type RepoSkillsResult,
  type SkillDir,
  type SkillInstallResult,
  type SkillScope,
} from '../../shared/skills'
import { downloadWithProgress } from '../agents/download'
import { getWorkspaceDir } from '../config/paths'
import type { ConfigStore } from '../config/store'
import { extractArchive } from '../util/archive'
import { withDeadline } from '../util/async'
import type { Logger } from '../util/logger'
import { parseRepoSource, refCandidates, repoLabel, tarballUrl, type RepoSource } from './github'
import { findSkillMd, scanContainer, scanLocal, scanTreeForSkills } from './scan'
import { mapRegistryEntry, pickLatestVersion, SKILLHUBS_REGISTRY } from './skillhubs'

// 技能域主进程核心：本地扫描、GitHub 仓库获取、skillhubs registry 搜索/安装。
// 技能是文件系统态（不进 config）：全部按需查询，无 watcher/推送事件。
// 网络路径的失败一律收敛为 { ok:false, message }（UI 反馈路径，不走异常信封）。

/** 仓库解包会话有效期（安装凭 sessionId 复用解包结果） */
const SESSION_TTL_MS = 30 * 60_000
/** 并存的解包会话上限（超出淘汰最旧并清理临时目录） */
const MAX_SESSIONS = 8
const DOWNLOAD_DEADLINE_MS = 120_000
const FETCH_DEADLINE_MS = 30_000
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

export interface SkillInstallTarget {
  scope: SkillScope
  assistantId?: string | undefined
  dir: SkillDir
}

interface RepoSession {
  /** 技能扫描根（subPath 解析后的目录） */
  rootDir: string
  /** 临时目录根（清理单位） */
  tmpRoot: string
  createdAt: number
  /** relPath='.'（整仓即单技能）时的安装目录名 */
  fallbackDirName: string
}

export class SkillsManager {
  private readonly store: ConfigStore
  private readonly log: Logger
  private readonly now: () => number
  /** sessionId → 解包会话；Map 迭代序 = 插入序，队首即最旧 */
  private readonly sessions = new Map<string, RepoSession>()

  constructor(store: ConfigStore, log: Logger, now: () => number = Date.now) {
    this.store = store
    this.log = log
    this.now = now
  }

  listLocal(req: { scope: SkillScope; assistantId?: string | undefined }): LocalSkillList {
    const root = this.resolveRoot(req.scope, req.assistantId)
    return { root, skills: scanLocal(root) }
  }

  listForAssistant(id: string): AssistantSkills {
    const assistant = this.requireAssistant(id)
    const dirs = skillDirsForAgent(assistant.agent_id)
    const workDir = effectiveWorkDir(assistant)
    const home = os.homedir()
    return {
      assistantId: assistant.id,
      agentId: assistant.agent_id,
      dirs,
      workDir,
      workspace: dirs.flatMap((dir) => scanContainer(workDir, dir)),
      global: dirs.flatMap((dir) => scanContainer(home, dir)),
    }
  }

  remove(req: { scope: SkillScope; assistantId?: string | undefined; dir: SkillDir; dirName: string }): ActionResult {
    if (!isSafeDirName(req.dirName)) return { ok: false, message: `非法技能目录名：${req.dirName}` }
    let root: string
    try {
      root = this.resolveRoot(req.scope, req.assistantId)
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
    const container = path.join(root, req.dir)
    const target = path.resolve(container, req.dirName)
    if (!isWithin(container, target) || target === path.resolve(container)) {
      return { ok: false, message: '目标路径越界' }
    }
    if (!fs.existsSync(target)) return { ok: false, message: `技能不存在：${target}` }
    // symlink 条目只移除链接本身（rm 不跟随），不动指向的真实目录
    fs.rmSync(target, { recursive: true, force: true })
    return { ok: true }
  }

  /** 列出 GitHub 仓库中的技能：codeload tarball → 解包 → 复用本地扫描器；解包结果记入会话供安装复用 */
  async listRepo(source: string): Promise<RepoSkillsResult> {
    const parsed = parseRepoSource(source)
    if (parsed === null) return { ok: false, message: '仓库地址无法识别（支持 owner/repo 或 github.com 链接）' }
    this.pruneSessions()

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-skills-'))
    try {
      const archivePath = path.join(tmpRoot, 'repo.tar.gz')
      await this.downloadRepo(parsed, archivePath)
      const size = fs.statSync(archivePath).size
      if (size > MAX_ARCHIVE_BYTES) {
        throw new Error(`仓库归档过大（${Math.round(size / 1024 / 1024)}MB，上限 200MB）`)
      }

      const extractDir = path.join(tmpRoot, 'x')
      fs.mkdirSync(extractDir)
      extractArchive(archivePath, extractDir)
      // codeload tarball 顶层为唯一的 <repo>-<ref>/ 目录
      const top = fs.readdirSync(extractDir)
      const topDirName = top[0]
      if (top.length !== 1 || topDirName === undefined) throw new Error('仓库归档结构异常（顶层目录不唯一）')
      let rootDir = path.join(extractDir, topDirName)
      if (parsed.subPath !== null) {
        const subDir = path.resolve(rootDir, parsed.subPath)
        if (!isWithin(rootDir, subDir) || !fs.existsSync(subDir) || !fs.statSync(subDir).isDirectory()) {
          throw new Error(`仓库内不存在子目录：${parsed.subPath}`)
        }
        rootDir = subDir
      }

      const fallbackDirName = parsed.subPath === null ? parsed.repo : path.basename(parsed.subPath)
      const skills = scanTreeForSkills(rootDir).map((entry) =>
        entry.relPath === '.'
          ? {
              ...entry,
              dirName: fallbackDirName,
              name: entry.name === path.basename(rootDir) ? fallbackDirName : entry.name,
            }
          : entry,
      )
      const sessionId = randomUUID()
      this.sessions.set(sessionId, { rootDir, tmpRoot, createdAt: this.now(), fallbackDirName })
      return { ok: true, sessionId, repoLabel: repoLabel(parsed), skills }
    } catch (error) {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
      return { ok: false, message: errorMessage(error) }
    }
  }

  installFromRepo(req: {
    sessionId: string
    relPath: string
    target: SkillInstallTarget
    overwrite: boolean
  }): SkillInstallResult {
    this.pruneSessions()
    const session = this.sessions.get(req.sessionId)
    if (session === undefined) return { ok: false, exists: false, message: '技能列表已过期，请重新获取' }
    const srcDir = path.resolve(session.rootDir, req.relPath)
    if (!isWithin(session.rootDir, srcDir)) return { ok: false, exists: false, message: '技能路径越界' }
    if (!fs.existsSync(srcDir) || findSkillMd(srcDir) === null) {
      return { ok: false, exists: false, message: '目录中没有 SKILL.md' }
    }
    const dirName = req.relPath === '.' ? session.fallbackDirName : path.basename(srcDir)
    return this.installDir(srcDir, req.target, dirName, req.overwrite)
  }

  async searchRegistry(keyword: string): Promise<RegistrySearchResult> {
    try {
      const url = `${SKILLHUBS_REGISTRY}/api/skills?search=${encodeURIComponent(keyword.trim())}`
      const response = await withDeadline(fetch(url), FETCH_DEADLINE_MS, 'registry 搜索')
      if (!response.ok) return { ok: false, message: `registry 请求失败：HTTP ${response.status}` }
      const json: unknown = await response.json()
      const rows: unknown[] = Array.isArray(json) ? json : []
      const skills = rows.map(mapRegistryEntry).filter((entry): entry is RegistrySkillEntry => entry !== null)
      return { ok: true, skills }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  async installFromRegistry(req: {
    name: string
    target: SkillInstallTarget
    overwrite: boolean
  }): Promise<SkillInstallResult> {
    if (!isSafeDirName(req.name)) return { ok: false, exists: false, message: `非法技能名：${req.name}` }
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-skillhub-'))
    try {
      const infoUrl = `${SKILLHUBS_REGISTRY}/api/skills/${encodeURIComponent(req.name)}`
      const infoRes = await withDeadline(fetch(infoUrl), FETCH_DEADLINE_MS, 'registry 查询')
      if (!infoRes.ok) return { ok: false, exists: false, message: `registry 请求失败：HTTP ${infoRes.status}` }
      const version = pickLatestVersion(await infoRes.json())
      if (version === null) return { ok: false, exists: false, message: `registry 中没有可用版本：${req.name}` }

      const archivePath = path.join(tmpRoot, `${req.name}.zip`)
      const downloadUrl = `${infoUrl}/${encodeURIComponent(version)}/download`
      await withDeadline(
        downloadWithProgress(downloadUrl, archivePath, () => {}),
        DOWNLOAD_DEADLINE_MS,
        '下载技能',
      )
      const extractDir = path.join(tmpRoot, 'x')
      fs.mkdirSync(extractDir)
      extractArchive(archivePath, extractDir)

      const srcDir = findSkillRoot(extractDir)
      if (srcDir === null) return { ok: false, exists: false, message: '压缩包中没有 SKILL.md' }
      const result = this.installDir(srcDir, req.target, req.name, req.overwrite)
      if (result.ok) normalizeSkillMdCase(result.path)
      return result
    } catch (error) {
      return { ok: false, exists: false, message: errorMessage(error) }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  }

  dispose(): void {
    // Map 迭代期间删除当前项是安全的（迭代器语义），无需拷贝键集
    for (const id of this.sessions.keys()) this.dropSession(id)
  }

  // ---------- 内部 ----------

  private async downloadRepo(source: RepoSource, destPath: string): Promise<void> {
    let lastError: unknown = null
    for (const ref of refCandidates(source)) {
      try {
        const url = tarballUrl(source, ref)
        await withDeadline(
          downloadWithProgress(url, destPath, () => {}),
          DOWNLOAD_DEADLINE_MS,
          '下载仓库',
        )
        return
      } catch (error) {
        lastError = error
      }
    }
    throw new Error(`下载仓库失败（${errorMessage(lastError)}）——确认仓库存在且为公开仓库`)
  }

  private installDir(
    srcDir: string,
    target: SkillInstallTarget,
    dirName: string,
    overwrite: boolean,
  ): SkillInstallResult {
    if (!isSafeDirName(dirName)) return { ok: false, exists: false, message: `非法技能目录名：${dirName}` }
    let root: string
    try {
      root = this.resolveRoot(target.scope, target.assistantId)
    } catch (error) {
      return { ok: false, exists: false, message: errorMessage(error) }
    }
    const container = path.join(root, target.dir)
    const dest = path.join(container, dirName)
    if (fs.existsSync(dest)) {
      if (!overwrite) return { ok: false, exists: true, message: `技能已存在：${dest}` }
      fs.rmSync(dest, { recursive: true, force: true })
    }
    fs.mkdirSync(container, { recursive: true })
    // cpSync 不解引用 symlink（原样复制）：归档内恶意链接不会产生越界写
    fs.cpSync(srcDir, dest, { recursive: true })
    this.log.info(`技能已安装：${dest}`)
    return { ok: true, path: dest }
  }

  private resolveRoot(scope: SkillScope, assistantId?: string): string {
    if (scope === 'global') return os.homedir()
    if (assistantId === undefined || assistantId === '') throw new Error('缺少 assistantId')
    return effectiveWorkDir(this.requireAssistant(assistantId))
  }

  private requireAssistant(id: string): AssistantConfig {
    const assistant = this.store.current.assistants.find((item) => item.id === id)
    if (assistant === undefined) throw new Error(`assistant 不存在：${id}`)
    return assistant
  }

  private pruneSessions(): void {
    const now = this.now()
    for (const [id, session] of this.sessions) {
      if (now - session.createdAt > SESSION_TTL_MS) this.dropSession(id)
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.dropSession(oldest)
    }
  }

  private dropSession(id: string): void {
    const session = this.sessions.get(id)
    if (session === undefined) return
    this.sessions.delete(id)
    try {
      fs.rmSync(session.tmpRoot, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败无碍
    }
  }
}

function effectiveWorkDir(assistant: AssistantConfig): string {
  return assistant.work_dir ?? getWorkspaceDir(assistant.id)
}

/** 安装/删除的目录名白名单：单段、非点目录引用 */
function isSafeDirName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\')
}

/** child 是否落在 parent 内（含相等）；配合白名单做路径越界兜底 */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 定位解包树中最浅的含 SKILL.md 的目录（根自身优先；BFS） */
function findSkillRoot(rootAbs: string): string | null {
  const queue = [rootAbs]
  while (queue.length > 0) {
    const dir = queue.shift()
    if (dir === undefined) break
    if (findSkillMd(dir) !== null) return dir
    let children: fs.Dirent[]
    try {
      children = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      if (child.isDirectory() && !child.name.startsWith('.') && child.name !== 'node_modules') {
        queue.push(path.join(dir, child.name))
      }
    }
  }
  return null
}

/** 安装目录内的 skill.md 变体统一为 SKILL.md（对齐 skillhubs CLI 行为） */
function normalizeSkillMdCase(dirAbs: string): void {
  try {
    const found = findSkillMd(dirAbs)
    if (found !== null && path.basename(found) !== 'SKILL.md') {
      fs.renameSync(found, path.join(dirAbs, 'SKILL.md'))
    }
  } catch {
    // 规范化失败不影响安装结果
  }
}
