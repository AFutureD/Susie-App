import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { detectAgentClis, findExecutable } from './cli-detect'

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-cli-detect-bin-'))
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'susie-cli-detect-empty-'))

function put(name: string, mode: number): string {
  const file = path.join(binDir, name)
  fs.writeFileSync(file, '#!/bin/sh\n', { mode })
  return file
}

afterAll(() => {
  fs.rmSync(binDir, { recursive: true, force: true })
  fs.rmSync(emptyDir, { recursive: true, force: true })
})

describe('findExecutable', () => {
  it('按 PATH 顺序找到首个可执行文件', () => {
    const file = put('codex', 0o755)
    expect(findExecutable('codex', `${emptyDir}:${binDir}`)).toBe(file)
  })

  it('无执行位的文件、目录与空 PATH 段都跳过', () => {
    put('claude', 0o644)
    fs.mkdirSync(path.join(binDir, 'gemini'))
    expect(findExecutable('claude', `:${binDir}:`)).toBeNull()
    expect(findExecutable('gemini', binDir)).toBeNull()
    expect(findExecutable('missing', binDir)).toBeNull()
  })
})

describe('detectAgentClis', () => {
  it('逐个命令返回路径或 null', () => {
    const codex = put('codex', 0o755)
    expect(detectAgentClis(binDir)).toEqual({ codex, claude: null })
  })
})
