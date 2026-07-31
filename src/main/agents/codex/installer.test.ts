import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexInstaller, codexTarballUrl, findCodexOnPath, platformTarget } from './installer'

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

describe('findCodexOnPath', () => {
  function makeExecutable(dir: string, name = 'codex'): string {
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    writeFileSync(file, '#!/bin/sh\necho codex-cli 0.0.0\n')
    chmodSync(file, 0o755)
    return file
  }

  it('resolves the first executable hit on PATH', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'susie-codex-path-'))
    const binDir = path.join(root, 'bin')
    makeExecutable(binDir)
    expect(findCodexOnPath(`${binDir}:/usr/bin`)).toBe(path.join(binDir, 'codex'))
  })

  it('skips hits inside node_modules (dev 下 pnpm 注入的 vendor wrapper)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'susie-codex-path-'))
    // 模拟 pnpm 布局：node_modules/.bin/codex -> ../@openai/codex/bin/codex.js
    const wrapperTarget = makeExecutable(path.join(root, 'node_modules', '@openai', 'codex', 'bin'), 'codex.js')
    const dotBin = path.join(root, 'node_modules', '.bin')
    mkdirSync(dotBin, { recursive: true })
    symlinkSync(wrapperTarget, path.join(dotBin, 'codex'))

    expect(findCodexOnPath(dotBin)).toBeNull()

    // node_modules 命中被跳过后，仍应继续找到后面的真实 codex
    const realBin = path.join(root, 'real-bin')
    makeExecutable(realBin)
    expect(findCodexOnPath(`${dotBin}:${realBin}`)).toBe(path.join(realBin, 'codex'))
  })

  it('accepts npm/mise global installs（bin 目录干净、symlink 指向 lib/node_modules）', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'susie-codex-path-'))
    // 模拟 npm -g 布局：<prefix>/bin/codex -> ../lib/node_modules/@openai/codex/bin/codex.js
    const target = makeExecutable(path.join(root, 'lib', 'node_modules', '@openai', 'codex', 'bin'), 'codex.js')
    const globalBin = path.join(root, 'bin')
    mkdirSync(globalBin, { recursive: true })
    symlinkSync(target, path.join(globalBin, 'codex'))

    expect(findCodexOnPath(globalBin)).toBe(path.join(globalBin, 'codex'))
  })

  it('returns null when PATH has no codex', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'susie-codex-path-'))
    expect(findCodexOnPath(root)).toBeNull()
  })
})

describe('CodexInstaller', () => {
  it('reads target version from the packaged @openai/codex metadata', () => {
    const installer = new CodexInstaller(tempDataDir())
    expect(installer.targetVersion()).toMatch(/^\d+\.\d+\.\d+/)
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

  it('prefers installed over PATH probe', () => {
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
