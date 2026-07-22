import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { AcpAgentRow } from '../../shared/messages'

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const REGISTRY_TTL_MS = 60 * 60 * 1000
const MANIFEST_FILE = 'install.json'

interface RegistryBinary {
  archive: string
  cmd: string
  args?: string[]
  env?: Record<string, string>
}

interface RegistryAgent {
  id: string
  name: string
  version: string
  description?: string
  distribution: {
    binary?: Record<string, RegistryBinary>
    npx?: { package: string; args?: string[] }
    uvx?: { package: string; args?: string[] }
  }
}

export interface InstalledManifest {
  id: string
  version: string
  kind: 'binary' | 'npx'
  cmd: string
  args: string[]
  env: Record<string, string>
}

export type AcpProgress = { id: string; phase: 'downloading' | 'extracting' | 'done' | 'error'; detail: string | null }

export function platformKey(): string {
  const osKey = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'windows'
  const archKey = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return `${osKey}-${archKey}`
}

/**
 * ACP registry：拉取官方 registry.json，安装 binary/npx 分发到本地缓存。
 * 目录布局：<dataDir>/registry/registry.json，<dataDir>/agents/<id>/{install.json, <version>/...}
 */
export class AcpRegistryManager {
  private readonly dataDir: string
  private readonly onProgress: (progress: AcpProgress) => void
  private cache: { agents: RegistryAgent[]; fetchedAt: number } | null = null

  constructor(dataDir: string, onProgress: (progress: AcpProgress) => void = () => {}) {
    this.dataDir = dataDir
    this.onProgress = onProgress
  }

  private agentDir(id: string): string {
    return path.join(this.dataDir, 'agents', id)
  }

  async fetchRegistry(force = false): Promise<RegistryAgent[]> {
    if (!force && this.cache !== null && Date.now() - this.cache.fetchedAt < REGISTRY_TTL_MS) {
      return this.cache.agents
    }

    const cacheFile = path.join(this.dataDir, 'registry', 'registry.json')
    try {
      const response = await fetch(REGISTRY_URL)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
      fs.writeFileSync(cacheFile, text, 'utf-8')
      const parsed = JSON.parse(text) as { agents?: RegistryAgent[] }
      this.cache = { agents: parsed.agents ?? [], fetchedAt: Date.now() }
      return this.cache.agents
    } catch (error) {
      // 网络失败回退磁盘缓存
      if (fs.existsSync(cacheFile)) {
        const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as { agents?: RegistryAgent[] }
        this.cache = { agents: parsed.agents ?? [], fetchedAt: Date.now() }
        return this.cache.agents
      }
      throw new Error(`拉取 ACP registry 失败：${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      })
    }
  }

  installedManifest(id: string): InstalledManifest | null {
    const manifestPath = path.join(this.agentDir(id), MANIFEST_FILE)
    if (!fs.existsSync(manifestPath)) return null
    try {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InstalledManifest
    } catch {
      return null
    }
  }

  async overview(): Promise<AcpAgentRow[]> {
    const agents = await this.fetchRegistry()
    const key = platformKey()
    return agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      version: agent.version,
      description: agent.description ?? '',
      installable: agent.distribution.binary?.[key] !== undefined || agent.distribution.npx !== undefined,
      installedVersion: this.installedManifest(agent.id)?.version ?? null,
    }))
  }

  async install(id: string): Promise<InstalledManifest> {
    const agents = await this.fetchRegistry()
    const agent = agents.find((a) => a.id === id)
    if (agent === undefined) throw new Error(`registry 中不存在 agent：${id}`)

    const binary = agent.distribution.binary?.[platformKey()]
    try {
      let manifest: InstalledManifest
      if (binary !== undefined) {
        manifest = await this.installBinary(agent, binary)
      } else if (agent.distribution.npx !== undefined) {
        const npx = agent.distribution.npx
        manifest = {
          id: agent.id,
          version: agent.version,
          kind: 'npx',
          cmd: 'npx',
          args: ['-y', npx.package, ...(npx.args ?? [])],
          env: {},
        }
        this.writeManifest(manifest)
      } else {
        throw new Error(`agent ${id} 在 ${platformKey()} 平台无可用分发（binary/npx）`)
      }
      this.onProgress({ id, phase: 'done', detail: manifest.version })
      return manifest
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.onProgress({ id, phase: 'error', detail })
      throw error
    }
  }

  uninstall(id: string): void {
    fs.rmSync(this.agentDir(id), { recursive: true, force: true })
  }

  private async installBinary(agent: RegistryAgent, binary: RegistryBinary): Promise<InstalledManifest> {
    this.onProgress({ id: agent.id, phase: 'downloading', detail: binary.archive })

    const response = await fetch(binary.archive)
    if (!response.ok || response.body === null) throw new Error(`下载失败：HTTP ${response.status}`)

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-acp-'))
    const archiveName = new URL(binary.archive).pathname.split('/').at(-1) ?? 'archive'
    const archivePath = path.join(tmpDir, archiveName)
    await pipeline(response.body, fs.createWriteStream(archivePath))

    this.onProgress({ id: agent.id, phase: 'extracting', detail: archiveName })
    const versionDir = path.join(this.agentDir(agent.id), agent.version)
    fs.rmSync(versionDir, { recursive: true, force: true })
    fs.mkdirSync(versionDir, { recursive: true })
    extractArchive(archivePath, versionDir)

    const cmdPath = path.join(versionDir, binary.cmd)
    if (!fs.existsSync(cmdPath)) throw new Error(`归档中找不到可执行文件：${binary.cmd}`)
    fs.chmodSync(cmdPath, 0o755)
    // 防御性清理 quarantine（Gatekeeper 会拦截被隔离的二进制）
    spawnSync('xattr', ['-rc', versionDir], { stdio: 'ignore' })

    const manifest: InstalledManifest = {
      id: agent.id,
      version: agent.version,
      kind: 'binary',
      cmd: cmdPath,
      args: binary.args ?? [],
      env: binary.env ?? {},
    }
    this.writeManifest(manifest)
    return manifest
  }

  private writeManifest(manifest: InstalledManifest): void {
    const dir = this.agentDir(manifest.id)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  }
}

/** macOS 自带 unzip/tar，免第三方解压依赖 */
function extractArchive(archivePath: string, targetDir: string): void {
  const lower = archivePath.toLowerCase()
  let result
  if (lower.endsWith('.zip')) {
    result = spawnSync('unzip', ['-o', '-q', archivePath, '-d', targetDir], { stdio: 'pipe' })
  } else if (
    lower.endsWith('.tar.gz') ||
    lower.endsWith('.tgz') ||
    lower.endsWith('.tar.xz') ||
    lower.endsWith('.tar')
  ) {
    result = spawnSync('tar', ['-xf', archivePath, '-C', targetDir], { stdio: 'pipe' })
  } else {
    // 无归档后缀：视为裸二进制
    fs.copyFileSync(archivePath, path.join(targetDir, path.basename(archivePath)))
    return
  }
  if (result.status !== 0) {
    throw new Error(`解压失败：${result.stderr?.toString() ?? 'unknown'}`)
  }
}
