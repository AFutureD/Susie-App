import fs from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'

const REPORT_INTERVAL_MS = 300

/**
 * 下载文件到 destPath，边写边回报字节进度。
 * total 取自 content-length；服务端不返回时为 null（UI 显示不确定进度）。
 * onProgress 按 300ms 节流，收尾必回报一次最终值。
 */
export async function downloadWithProgress(
  url: string,
  destPath: string,
  onProgress: (received: number, total: number | null) => void,
): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || response.body === null) throw new Error(`下载失败：HTTP ${response.status}`)

  const lengthHeader = response.headers.get('content-length')
  const parsed = lengthHeader === null ? NaN : Number(lengthHeader)
  const total = Number.isFinite(parsed) && parsed > 0 ? parsed : null

  let received = 0
  let lastReport = 0
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      const now = Date.now()
      if (now - lastReport >= REPORT_INTERVAL_MS) {
        lastReport = now
        onProgress(received, total)
      }
      callback(null, chunk)
    },
  })

  onProgress(0, total)
  await pipeline(Readable.fromWeb(response.body as WebReadableStream), counter, fs.createWriteStream(destPath))
  onProgress(received, total)
}
