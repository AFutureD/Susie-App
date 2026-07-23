import { readFileSync, mkdtempSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { downloadWithProgress } from './download'

const PAYLOAD = Buffer.alloc(256 * 1024, 7)

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/with-length') {
      res.writeHead(200, { 'content-length': String(PAYLOAD.length) })
      res.end(PAYLOAD)
      return
    }
    if (req.url === '/chunked') {
      res.writeHead(200) // 无 content-length（chunked）
      res.end(PAYLOAD)
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${address.port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

describe('downloadWithProgress', () => {
  it('writes the file and reports monotonic progress with total', async () => {
    const dest = path.join(mkdtempSync(path.join(tmpdir(), 'susie-dl-')), 'out.bin')
    const events: Array<{ received: number; total: number | null }> = []
    await downloadWithProgress(`${baseUrl}/with-length`, dest, (received, total) => {
      events.push({ received, total })
    })

    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events[0]).toEqual({ received: 0, total: PAYLOAD.length })
    expect(events.at(-1)).toEqual({ received: PAYLOAD.length, total: PAYLOAD.length })
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.received).toBeGreaterThanOrEqual(events[i - 1]!.received)
    }
  })

  it('reports null total when content-length is absent', async () => {
    const dest = path.join(mkdtempSync(path.join(tmpdir(), 'susie-dl-')), 'out.bin')
    const totals: Array<number | null> = []
    await downloadWithProgress(`${baseUrl}/chunked`, dest, (received, total) => {
      totals.push(total)
    })
    expect(readFileSync(dest).equals(PAYLOAD)).toBe(true)
    expect(totals.every((total) => total === null)).toBe(true)
  })

  it('throws on http errors', async () => {
    const dest = path.join(mkdtempSync(path.join(tmpdir(), 'susie-dl-')), 'out.bin')
    await expect(downloadWithProgress(`${baseUrl}/missing`, dest, () => {})).rejects.toThrow('HTTP 404')
  })
})
