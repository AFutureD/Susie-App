import { describe, expect, it } from 'vitest'
import type { AssistantConfig } from '../../../../shared/config'
import type { AgentInfo } from '../../../../shared/messages'
import { reconcileDefaultAssistant, shouldOnboard } from './model'

describe('shouldOnboard', () => {
  it('首启（本次启动时 config.toml 不存在）→ 进入', () => {
    expect(shouldOnboard({ firstRun: true, lastError: null })).toBe(true)
  })

  it('config.toml 已存在 → 不进入（无论内容多不完整）', () => {
    expect(shouldOnboard({ firstRun: false, lastError: null })).toBe(false)
  })

  it('配置损坏（last-good 运行）→ 不进入，错误横幅负责提示', () => {
    expect(shouldOnboard({ firstRun: false, lastError: 'TOML 解析失败' })).toBe(false)
    // 理论上首启即损坏（默认文件写入后被并发改坏）也不进——向导写入会覆盖现场
    expect(shouldOnboard({ firstRun: true, lastError: '读取配置失败' })).toBe(false)
  })
})

describe('reconcileDefaultAssistant', () => {
  const assistant = (agentId: string): AssistantConfig => ({ id: 'default', agent_id: agentId })
  const agent = (partial: Partial<AgentInfo> & Pick<AgentInfo, 'id' | 'source'>): AgentInfo => ({
    name: partial.id,
    description: '',
    installable: true,
    installedVersion: null,
    latestVersion: null,
    mcpHttp: null,
    ...partial,
  })

  it('指向的 agent 可用（含 PATH 来源）→ 不改', () => {
    const overview = [agent({ id: 'codex', source: 'path' }), agent({ id: 'claude-acp', source: 'installed' })]
    expect(reconcileDefaultAssistant([assistant('codex')], overview)).toBeNull()
  })

  it('codex 未装、只装了其他 agent → 改指首个可用候选', () => {
    const overview = [agent({ id: 'codex', source: null }), agent({ id: 'claude-acp', source: 'installed' })]
    expect(reconcileDefaultAssistant([assistant('codex')], overview)).toEqual({
      id: 'default',
      agent_id: 'claude-acp',
    })
  })

  it('改写保留 assistant 其余字段', () => {
    const full: AssistantConfig = { id: 'default', agent_id: 'codex', work_dir: '/tmp/w', model: 'gpt-5' }
    const overview = [agent({ id: 'claude-acp', source: 'installed' })]
    expect(reconcileDefaultAssistant([full], overview)).toEqual({ ...full, agent_id: 'claude-acp' })
  })

  it('候选口径与 assistants 页一致：mcpHttp === false 的 agent 不进候选（null 保守放行）', () => {
    const overview = [
      agent({ id: 'no-http', source: 'installed', mcpHttp: false }),
      agent({ id: 'claude-acp', source: 'installed' }),
    ]
    expect(reconcileDefaultAssistant([assistant('codex')], overview)?.agent_id).toBe('claude-acp')
  })

  it('什么都没装 → 不改（保持 codex，运行时引导下载）', () => {
    const overview = [agent({ id: 'codex', source: null }), agent({ id: 'claude-acp', source: null })]
    expect(reconcileDefaultAssistant([assistant('codex')], overview)).toBeNull()
  })

  it('无 default 时回退首个 assistant；assistants 为空不改', () => {
    const other: AssistantConfig = { id: 'work', agent_id: 'codex' }
    const overview = [agent({ id: 'claude-acp', source: 'installed' })]
    expect(reconcileDefaultAssistant([other], overview)).toEqual({ id: 'work', agent_id: 'claude-acp' })
    expect(reconcileDefaultAssistant([], overview)).toBeNull()
  })
})
