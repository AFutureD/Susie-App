import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** macOS 自带 unzip/tar，免第三方解压依赖（bsdtar/unzip 默认拒绝 `..`/绝对路径条目） */
export function extractArchive(archivePath: string, targetDir: string): void {
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
