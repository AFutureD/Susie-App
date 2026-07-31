import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import type { AgentProgress } from '../../../shared/messages'
import { downloadWithProgress } from '../download'

const require = createRequire(import.meta.url)

export const CODEX_AGENT_ID = 'codex'
const MANIFEST_FILE = 'install.json'

/** npm 平台别名后缀（@openai/codex@<ver>-<suffix>）与 tarball 内 vendor 目录名 */
export function platformTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): { suffix: string; vendorTriple: string } | null {
  if (platform === 'darwin') {
    if (arch === 'arm64') return { suffix: 'darwin-arm64', vendorTriple: 'aarch64-apple-darwin' }
    if (arch === 'x64') return { suffix: 'darwin-x64', vendorTriple: 'x86_64-apple-darwin' }
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { suffix: 'linux-arm64', vendorTriple: 'aarch64-unknown-linux-musl' }
    if (arch === 'x64') return { suffix: 'linux-x64', vendorTriple: 'x86_64-unknown-linux-musl' }
  }
  return null
}

/** 平台包是 @openai/codex 的 npm alias，真实 tarball 挂在 @openai/codex 名下 */
export function codexTarballUrl(version: string, suffix: string): string {
  return `https://registry.npmjs.org/@openai/codex/-/codex-${version}-${suffix}.tgz`
}

export interface CodexResolved {
  source: 'installed' | 'path'
  version: string
  /** spawn 用；'codex' 表示交给 PATH 解析 */
  executablePath: string
  /** vendor codex-path 目录（rg 等辅助工具）；spawn 时需前置到 PATH */
  pathDir: string | null
}

interface CodexManifest {
  version: string
  executablePath: string
  pathDir: string | null
}

/**
 * 在 PATH 中定位 codex，跳过 node_modules 内的 PATH 目录：dev 下 pnpm script
 * 会把项目 node_modules/.bin 前置注入 PATH，其中的 @openai/codex vendor wrapper
 * 会被误认成用户自装的 codex——该来源已被明确禁用（只认 已下载 → PATH）。
 * 注意只看 PATH 目录本身，不能看 realpath 后的目标：npm/mise 全局安装的 codex
 * 同样是指向 lib/node_modules/.../codex.js 的 symlink，那是合法的用户安装。
 */
export function findCodexOnPath(envPath: string = process.env['PATH'] ?? ''): string | null {
  for (const dir of envPath.split(path.delimiter)) {
    if (dir === '' || dir.split(path.sep).includes('node_modules')) continue
    const candidate = path.join(dir, 'codex')
    try {
      if (!fs.statSync(candidate).isFile()) continue
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

/**
 * codex 二进制按需下载器。二进制不随应用分发（~300MB），
 * 从 npm registry 拉取 @openai/codex 锁定的版本到 <dataDir>/<version>/。
 * 解析顺序：已下载 → PATH。开发环境体验与正式版一致。
 */
export class CodexInstaller {
  private readonly dataDir: string
  private readonly onProgress: (progress: AgentProgress) => void

  constructor(dataDir: string, onProgress: (progress: AgentProgress) => void = () => {}) {
    this.dataDir = dataDir
    this.onProgress = onProgress
  }

  /** SDK 期望的 codex 版本（@openai/codex 随应用打包的只有 package.json） */
  targetVersion(): string | null {
    try {
      const pkgPath = require.resolve('@openai/codex/package.json')
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string }
      return pkg.version ?? null
    } catch {
      return null
    }
  }

  installed(): CodexResolved | null {
    try {
      const raw = fs.readFileSync(path.join(this.dataDir, MANIFEST_FILE), 'utf-8')
      const manifest = JSON.parse(raw) as CodexManifest
      if (!fs.existsSync(manifest.executablePath)) return null
      return { source: 'installed', ...manifest }
    } catch {
      return null
    }
  }

  pathProbe(): CodexResolved | null {
    const executable = findCodexOnPath()
    if (executable === null) return null
    const probe = spawnSync(executable, ['--version'], { encoding: 'utf-8' })
    if (probe.status !== 0) return null
    return { source: 'path', version: probe.stdout.trim(), executablePath: executable, pathDir: null }
  }

  resolve(): CodexResolved | null {
    return this.installed() ?? this.pathProbe()
  }

  async install(): Promise<CodexResolved> {
    try {
      const target = platformTarget()
      if (target === null) throw new Error(`不支持的平台：${process.platform}/${process.arch}`)
      const version = this.targetVersion()
      if (version === null) throw new Error('无法确定 codex 目标版本（@openai/codex 未随应用打包）')

      const url = codexTarballUrl(version, target.suffix)
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-codex-'))
      const archivePath = path.join(tmpDir, 'codex.tgz')
      await downloadWithProgress(url, archivePath, (received, total) => {
        this.onProgress({ id: CODEX_AGENT_ID, phase: 'downloading', detail: `codex v${version}`, received, total })
      })

      this.onProgress({ id: CODEX_AGENT_ID, phase: 'extracting', detail: `codex v${version}` })
      const versionDir = path.join(this.dataDir, version)
      fs.rmSync(versionDir, { recursive: true, force: true })
      fs.mkdirSync(versionDir, { recursive: true })
      const result = spawnSync('tar', ['-xzf', archivePath, '-C', versionDir], { stdio: 'pipe' })
      if (result.status !== 0) throw new Error(`解压失败：${result.stderr?.toString() ?? 'unknown'}`)
      fs.rmSync(tmpDir, { recursive: true, force: true })

      const vendorDir = path.join(versionDir, 'package', 'vendor', target.vendorTriple)
      const executablePath = path.join(vendorDir, 'bin', 'codex')
      if (!fs.existsSync(executablePath)) throw new Error('归档中找不到 codex 可执行文件')
      fs.chmodSync(executablePath, 0o755)
      const pathDirCandidate = path.join(vendorDir, 'codex-path')
      let pathDir: string | null = null
      if (fs.existsSync(pathDirCandidate)) {
        pathDir = pathDirCandidate
        for (const entry of fs.readdirSync(pathDirCandidate)) {
          fs.chmodSync(path.join(pathDirCandidate, entry), 0o755)
        }
      }
      // 防御性清理 quarantine（Gatekeeper 会拦截被隔离的二进制）
      spawnSync('xattr', ['-rc', versionDir], { stdio: 'ignore' })

      const manifest: CodexManifest = { version, executablePath, pathDir }
      fs.writeFileSync(path.join(this.dataDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')

      // 只保留当前版本，旧版本目录（每个 ~300MB）直接清掉
      for (const entry of fs.readdirSync(this.dataDir)) {
        if (entry !== version && entry !== MANIFEST_FILE) {
          fs.rmSync(path.join(this.dataDir, entry), { recursive: true, force: true })
        }
      }

      this.onProgress({ id: CODEX_AGENT_ID, phase: 'done', detail: `v${version}` })
      return { source: 'installed', ...manifest }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.onProgress({ id: CODEX_AGENT_ID, phase: 'error', detail })
      throw error
    }
  }

  uninstall(): void {
    fs.rmSync(this.dataDir, { recursive: true, force: true })
  }
}
