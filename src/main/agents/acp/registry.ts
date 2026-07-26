import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AgentProgress } from '../../../shared/messages'
import { probeAcpMcpHttp } from './probe'
import { downloadWithProgress } from '../download'

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

/** registry 视角的 agent 行（provider 映射为共享的 AgentInfo） */
export interface AcpAgentRow {
  id: string
  name: string
  version: string
  description: string
  /** 本平台是否有可用分发（binary/npx） */
  installable: boolean
  installedVersion: string | null
  mcpHttp: boolean | null
}

export interface InstalledManifest {
  id: string
  version: string
  kind: 'binary' | 'npx'
  cmd: string
  args: string[]
  env: Record<string, string>
  /** 安装后探测的 http MCP 支持（susie 注入 send_message 的唯一方式）；null = 探测失败（未知） */
  mcpHttp?: boolean | null
}

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
  private readonly onProgress: (progress: AgentProgress) => void
  private cache: { agents: RegistryAgent[]; fetchedAt: number } | null = null

  constructor(dataDir: string, onProgress: (progress: AgentProgress) => void = () => {}) {
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
    return agents
      .map((agent) => {
        const manifest = this.installedManifest(agent.id)
        return {
          id: agent.id,
          name: agent.name,
          version: agent.version,
          description: agent.description ?? '',
          installable: agent.distribution.binary?.[key] !== undefined || agent.distribution.npx !== undefined,
          installedVersion: manifest?.version ?? null,
          mcpHttp: manifest?.mcpHttp ?? null,
        }
      })
      .sort(compareAcpRows)
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

      // 安装收尾探测 MCP 能力：不支持 http MCP 的 agent 拿不到 susie 工具（send_message 等），
      // Agent 页据此提示「不支持」。探测失败不算安装失败——记 null（未知）。
      this.onProgress({ id, phase: 'probing', detail: manifest.version })
      manifest.mcpHttp = await probeAcpMcpHttp(manifest).catch(() => null)
      this.writeManifest(manifest)

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
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-acp-'))
    const archiveName = new URL(binary.archive).pathname.split('/').at(-1) ?? 'archive'
    const archivePath = path.join(tmpDir, archiveName)
    await downloadWithProgress(binary.archive, archivePath, (received, total) => {
      this.onProgress({ id: agent.id, phase: 'downloading', detail: archiveName, received, total })
    })

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

/** Agent 页 ACP 列表排序：状态优先（已安装 > 可安装 > 不可安装），同状态按名称 */
export function compareAcpRows(a: AcpAgentRow, b: AcpAgentRow): number {
  const rank = (row: AcpAgentRow): number => (row.installedVersion !== null ? 0 : row.installable ? 1 : 2)
  return rank(a) - rank(b) || a.name.localeCompare(b.name)
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
