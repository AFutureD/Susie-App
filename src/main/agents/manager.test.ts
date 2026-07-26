import { describe, expect, it, vi } from 'vitest'
import type { AgentInfo } from '../../shared/messages'
import { AgentManager } from './manager'
import type { AgentProvider } from './provider'

const silentLog = { info: () => {}, error: () => {} }

function info(id: string): AgentInfo {
  return {
    id,
    name: id,
    description: '',
    installable: true,
    installedVersion: null,
    latestVersion: null,
    source: null,
    mcpHttp: null,
  }
}

function makeProvider(id: string, owns: (agentId: string) => boolean, rows: AgentInfo[] = []): AgentProvider {
  return {
    id,
    owns,
    overview: vi.fn(async () => rows),
    listModels: vi.fn(async () => [{ value: `${id}-model`, name: `${id}-model` }]),
    install: vi.fn(async () => {}),
    uninstall: vi.fn(),
    createRuntime: vi.fn(),
  }
}

describe('AgentManager', () => {
  it('按注册序解析：codex 精确认领，acp 兜底', async () => {
    const codex = makeProvider('codex', (agentId) => agentId === 'codex')
    const acp = makeProvider('acp', () => true)
    const manager = new AgentManager([codex, acp], silentLog)

    await manager.install('codex')
    expect(codex.install).toHaveBeenCalledTimes(1)
    expect(acp.install).not.toHaveBeenCalled()

    await manager.install('some-registry-agent')
    expect(acp.install).toHaveBeenCalledWith('some-registry-agent')
  })

  it('overview 行归属跟随解析规则：后位 provider 的同 id 行不展示（registry 收录 codex 的场景）', async () => {
    const codex = makeProvider('codex', (agentId) => agentId === 'codex', [info('codex')])
    const acp = makeProvider('acp', () => true, [info('codex'), info('claude-code')])
    const manager = new AgentManager([codex, acp], silentLog)

    expect((await manager.overview()).map((row) => row.id)).toEqual(['codex', 'claude-code'])
  })

  it('overview 聚合保持注册序；单 provider 失败降级为空段', async () => {
    const codex = makeProvider('codex', (agentId) => agentId === 'codex', [info('codex')])
    const acp = makeProvider('acp', () => true)
    acp.overview = vi.fn(async () => {
      throw new Error('registry 不可用')
    })
    const errors: string[] = []
    const manager = new AgentManager([codex, acp], { info: () => {}, error: (m) => errors.push(m) })

    expect((await manager.overview()).map((row) => row.id)).toEqual(['codex'])
    expect(errors.some((line) => line.includes('registry 不可用'))).toBe(true)
  })

  it('模型枚举缓存：命中 TTL 内不再探测；空结果不缓存', async () => {
    const codex = makeProvider('codex', (agentId) => agentId === 'codex')
    const manager = new AgentManager([codex], silentLog)

    expect(await manager.listModels('codex')).toHaveLength(1)
    expect(await manager.listModels('codex')).toHaveLength(1)
    expect(codex.listModels).toHaveBeenCalledTimes(1)

    const empty = makeProvider('codex2', () => true)
    empty.listModels = vi.fn(async () => [])
    const manager2 = new AgentManager([empty], silentLog)
    await manager2.listModels('x')
    await manager2.listModels('x')
    expect(empty.listModels).toHaveBeenCalledTimes(2)
  })

  it('listModels 异常收敛为空数组（不抛给 IPC）', async () => {
    const boom = makeProvider('acp', () => true)
    boom.listModels = vi.fn(async () => {
      throw new Error('probe failed')
    })
    const manager = new AgentManager([boom], silentLog)
    expect(await manager.listModels('x')).toEqual([])
  })
})
