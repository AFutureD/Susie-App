// 重新生成 src/generated 协议类型：
//   npm run generate -w @susie/codex-app-server
//
// 二进制严格取自 node_modules 里 @openai/codex 锁定的平台包（与运行时下载
// 的版本同源），保证生成的类型与实际 spawn 的 app-server 协议一致。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

function platformTarget() {
  const { platform, arch } = process
  if (platform === 'darwin' && arch === 'arm64') return { suffix: 'darwin-arm64', vendorTriple: 'aarch64-apple-darwin' }
  if (platform === 'darwin' && arch === 'x64') return { suffix: 'darwin-x64', vendorTriple: 'x86_64-apple-darwin' }
  if (platform === 'linux' && arch === 'arm64')
    return { suffix: 'linux-arm64', vendorTriple: 'aarch64-unknown-linux-musl' }
  if (platform === 'linux' && arch === 'x64') return { suffix: 'linux-x64', vendorTriple: 'x86_64-unknown-linux-musl' }
  throw new Error(`不支持的平台：${platform}/${arch}`)
}

const pinned = require('@openai/codex/package.json').version
const target = platformTarget()
const vendorPkgJson = require.resolve(`@openai/codex-${target.suffix}/package.json`)
const vendorVersion = require(`@openai/codex-${target.suffix}/package.json`).version

if (!vendorVersion.startsWith(`${pinned}-`) && vendorVersion !== pinned) {
  throw new Error(`平台包版本 ${vendorVersion} 与 @openai/codex 锁定版本 ${pinned} 不一致，请先 npm install`)
}

const codexBin = path.join(path.dirname(vendorPkgJson), 'vendor', target.vendorTriple, 'bin', 'codex')
if (!fs.existsSync(codexBin)) throw new Error(`codex 可执行文件不存在：${codexBin}`)

const outDir = path.join(packageDir, 'src', 'generated')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const result = spawnSync(codexBin, ['app-server', 'generate-ts', '--experimental', '--out', outDir], {
  stdio: 'inherit',
})
if (result.status !== 0) throw new Error(`generate-ts 失败（exit ${result.status}）`)

fs.writeFileSync(path.join(outDir, 'VERSION'), `${pinned}\n`, 'utf-8')
console.log(`generated: codex app-server protocol v${pinned} → ${path.relative(packageDir, outDir)}`)
