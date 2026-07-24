// 发布产物上传：electron-builder --publish never 之后，用 gh 把 release/ 下的产物
// 传到 GitHub Release 并逐一核对大小。
//
// 为什么不用 electron-builder 自带的 --publish：
// 1. electron-builder 26.15.3 上传 ~100MB 大文件会静默失败（exit 0 但 asset 缺失）；
// 2. 它创建的 release 是 draft，electron-updater 匿名请求不可见，容易忘记转正式。
// 此脚本一步到位：create（非 draft）→ upload --clobber → 远端/本地大小逐一核对。
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))
const tag = `v${version}`

const assets = [
  `Susie-${version}-arm64.zip`,
  `Susie-${version}-arm64.zip.blockmap`,
  `Susie-${version}-arm64.dmg`,
  `Susie-${version}-arm64.dmg.blockmap`,
  'latest-mac.yml',
]

function gh(args, opts = {}) {
  return execFileSync('gh', args, { cwd: root, encoding: 'utf-8', ...opts })
}

// 1. 本地产物齐全性
const missing = assets.filter((name) => !existsSync(path.join(root, 'release', name)))
if (missing.length > 0) {
  console.error(`[release] 本地产物缺失：${missing.join(', ')}（先跑 electron-builder）`)
  process.exit(1)
}

// 2. release 不存在则创建（直接正式，不走 draft）
let exists = true
try {
  gh(['release', 'view', tag, '--json', 'name'], { stdio: ['ignore', 'pipe', 'ignore'] })
} catch {
  exists = false
}
if (!exists) {
  console.log(`[release] 创建 ${tag}`)
  gh(['release', 'create', tag, '--title', tag, '--notes', `Susie ${version}`], { stdio: 'inherit' })
} else {
  console.log(`[release] ${tag} 已存在，覆盖上传产物`)
}

// 3. 上传（--clobber 幂等，可重跑）
gh(['release', 'upload', tag, ...assets.map((name) => path.join('release', name)), '--clobber'], {
  stdio: 'inherit',
})

// 4. 远端大小逐一核对（防静默截断）
const remote = JSON.parse(gh(['release', 'view', tag, '--json', 'assets,isDraft']))
if (remote.isDraft) {
  console.log('[release] 仍为 draft，转正式')
  gh(['release', 'edit', tag, '--draft=false'], { stdio: 'inherit' })
}
const remoteSizes = new Map(remote.assets.map((asset) => [asset.name, asset.size]))
const bad = assets.filter((name) => remoteSizes.get(name) !== statSync(path.join(root, 'release', name)).size)
if (bad.length > 0) {
  console.error(`[release] 远端大小不一致：${bad.join(', ')}（重跑本脚本覆盖上传）`)
  process.exit(1)
}

console.log(`[release] ✅ ${tag} 发布完成，${assets.length} 个产物齐全且大小一致`)
console.log(`[release] https://github.com/AFutureD/Susie-App/releases/tag/${tag}`)
