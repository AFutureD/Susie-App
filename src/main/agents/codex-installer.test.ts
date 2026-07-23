import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexInstaller, codexTarballUrl, platformTarget } from './codex-installer'

function tempDataDir(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'susie-codex-test-')), 'codex')
}

describe('platformTarget / codexTarballUrl', () => {
  it('maps platform/arch to npm alias suffix and vendor triple', () => {
    expect(platformTarget('darwin', 'arm64')).toEqual({
      suffix: 'darwin-arm64',
      vendorTriple: 'aarch64-apple-darwin',
    })
    expect(platformTarget('linux', 'x64')).toEqual({
      suffix: 'linux-x64',
      vendorTriple: 'x86_64-unknown-linux-musl',
    })
    expect(platformTarget('win32', 'x64')).toBeNull()
  })

  it('builds the real tarball URL behind the npm alias', () => {
    expect(codexTarballUrl('0.145.0', 'darwin-arm64')).toBe(
      'https://registry.npmjs.org/@openai/codex/-/codex-0.145.0-darwin-arm64.tgz',
    )
  })
})

describe('CodexInstaller', () => {
  it('reads target version from the packaged @openai/codex metadata', () => {
    const installer = new CodexInstaller(tempDataDir())
    expect(installer.targetVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('resolves the dev vendor binary from node_modules', () => {
    const installer = new CodexInstaller(tempDataDir())
    const dev = installer.devVendor()
    expect(dev).not.toBeNull()
    expect(dev?.source).toBe('dev')
    expect(existsSync(dev?.executablePath ?? '')).toBe(true)
  })

  it('returns null for installed() when manifest is missing or stale', () => {
    const dataDir = tempDataDir()
    const installer = new CodexInstaller(dataDir)
    expect(installer.installed()).toBeNull()

    // manifest 指向不存在的二进制 → 视为未安装
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(
      path.join(dataDir, 'install.json'),
      JSON.stringify({ version: '0.0.1', executablePath: path.join(dataDir, 'gone'), pathDir: null }),
    )
    expect(installer.installed()).toBeNull()
  })

  it('prefers installed over dev vendor', () => {
    const dataDir = tempDataDir()
    mkdirSync(dataDir, { recursive: true })
    const fakeBin = path.join(dataDir, 'codex')
    writeFileSync(fakeBin, '#!/bin/sh\n')
    writeFileSync(
      path.join(dataDir, 'install.json'),
      JSON.stringify({ version: '9.9.9', executablePath: fakeBin, pathDir: null }),
    )
    const installer = new CodexInstaller(dataDir)
    expect(installer.resolve()?.source).toBe('installed')
    expect(installer.resolve()?.version).toBe('9.9.9')
  })

  // 真实下载 ~100MB，默认跳过：SUSIE_CODEX_DL_IT=1 npx vitest run src/main/agents/codex-installer.test.ts
  it.skipIf(process.env['SUSIE_CODEX_DL_IT'] !== '1')(
    'downloads, extracts and runs the real codex binary',
    { timeout: 600_000 },
    async () => {
      const dataDir = tempDataDir()
      const events: string[] = []
      const installer = new CodexInstaller(dataDir, (progress) => events.push(progress.phase))

      const manifest = await installer.install()
      expect(existsSync(manifest.executablePath)).toBe(true)
      expect(events).toEqual(['downloading', 'extracting', 'done'])
      expect(installer.resolve()?.source).toBe('installed')

      const probe = spawnSync(manifest.executablePath, ['--version'], { encoding: 'utf-8' })
      expect(probe.status).toBe(0)
      expect(probe.stdout).toContain(manifest.version)
    },
  )
})
