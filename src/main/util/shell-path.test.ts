import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Logger } from './logger'
import { mergeLoginShellPath, mergePathEntries } from './shell-path'

function collectLogger(): Logger & { infos: string[]; errors: string[] } {
  const infos: string[] = []
  const errors: string[] = []
  return {
    infos,
    errors,
    info: (message) => infos.push(message),
    error: (message) => errors.push(message),
  }
}

/** 生成假 shell：忽略 -l -i，仅以固定 PATH eval -c 的命令（$4） */
function fakeShell(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'susie-shell-test-'))
  const file = path.join(dir, 'fake-shell.sh')
  writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf-8')
  chmodSync(file, 0o755)
  return file
}

describe('mergePathEntries', () => {
  it('login shell 项在前，保留 current 独有项，去重去空', () => {
    expect(mergePathEntries('/usr/bin:/bin::/opt/only-current', '/Users/me/mise/bin:/usr/bin')).toBe(
      '/Users/me/mise/bin:/usr/bin:/bin:/opt/only-current',
    )
  })
})

describe('mergeLoginShellPath', () => {
  const originalPath = process.env['PATH']
  afterEach(() => {
    process.env['PATH'] = originalPath
  })

  it('把 login shell 解析出的 PATH 合并进 process.env.PATH（容忍 rc 噪音输出）', async () => {
    const shell = fakeShell(`echo "rc noise"\nPATH="/fake/mise/bin:/usr/bin"\neval "$4"`)
    const log = collectLogger()
    expect(await mergeLoginShellPath(log, { shell })).toBe(true)
    expect(process.env['PATH']?.startsWith('/fake/mise/bin:/usr/bin')).toBe(true)
    expect(log.errors).toEqual([])
  })

  it('输出无标记时降级：PATH 不变，记 error', async () => {
    const shell = fakeShell(`echo "broken shell"`)
    const log = collectLogger()
    expect(await mergeLoginShellPath(log, { shell })).toBe(false)
    expect(process.env['PATH']).toBe(originalPath)
    expect(log.errors).toHaveLength(1)
  })

  it('shell 挂起时按超时降级', async () => {
    const shell = fakeShell(`sleep 5`)
    const log = collectLogger()
    expect(await mergeLoginShellPath(log, { shell, timeoutMs: 200 })).toBe(false)
    expect(log.errors[0]).toContain('超时')
  })
})
