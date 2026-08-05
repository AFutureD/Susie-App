import { describe, expect, it } from 'vitest'
import { configSchema, type AssistantConfig, type ConfigState } from '../../../../shared/config'
import type { AgentInfo } from '../../../../shared/messages'
import { needsFallbackBinding, reconcileDefaultAssistant, shouldOnboard } from './model'

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

describe('needsFallbackBinding', () => {
  const makeState = (overrides: Record<string, unknown>): ConfigState => ({
    version: 1,
    configPath: '/tmp/config.toml',
    config: configSchema.parse({
      channels: { bot: { type: 'telegram_bot', token: '1:x' } },
      ...overrides,
    }),
    lastError: null,
    firstRun: true,
  })

  it('渠道已建且无通道默认绑定 → 需要回落', () => {
    expect(needsFallbackBinding(makeState({}), 'bot')).toBe(true)
  })

  it('已有通道默认绑定 → 不回落（不覆盖绑定步已写内容）', () => {
    const state = makeState({ bindings: [{ channel: 'bot', chat_id: '*', assistant_id: 'default' }] })
    expect(needsFallbackBinding(state, 'bot')).toBe(false)
  })

  it('仅精确绑定不算通道默认 → 仍需回落', () => {
    const state = makeState({ bindings: [{ channel: 'bot', chat_id: 'P:1', assistant_id: 'default' }] })
    expect(needsFallbackBinding(state, 'bot')).toBe(true)
  })

  it('渠道不存在或未走到建渠道步（channelId null）→ 不回落', () => {
    expect(needsFallbackBinding(makeState({}), 'gone')).toBe(false)
    expect(needsFallbackBinding(makeState({}), null)).toBe(false)
  })
})
