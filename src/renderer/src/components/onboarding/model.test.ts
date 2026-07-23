import { describe, expect, it } from 'vitest'
import { configSchema, type Config } from '../../../../shared/config'
import { onboardingStepFor } from './model'

const emptyConfig = configSchema.parse({})

function configWith(partial: Partial<Config>): Config {
  return configSchema.parse({
    channels: { my_bot: { type: 'telegram_bot', token: '1:x' } },
    bindings: [{ channel: 'my_bot', assistant_id: 'default' }],
    ...partial,
  })
}

describe('onboardingStepFor', () => {
  it('空配置 → 第 1 步（添加频道）', () => {
    expect(onboardingStepFor({ config: emptyConfig, lastError: null }, false)).toBe('channel')
  })

  it('有频道但无绑定 → 第 2 步（会话绑定，覆盖中途退出恢复）', () => {
    expect(onboardingStepFor({ config: configWith({ bindings: [] }), lastError: null }, false)).toBe('binding')
  })

  it('频道与绑定齐备 → 不显示', () => {
    expect(onboardingStepFor({ config: configWith({}), lastError: null }, false)).toBeNull()
  })

  it('已完成标记 → 任何配置都不显示', () => {
    expect(onboardingStepFor({ config: emptyConfig, lastError: null }, true)).toBeNull()
  })

  it('配置损坏（last-good 运行）→ 不显示，避免误判未配置', () => {
    expect(onboardingStepFor({ config: emptyConfig, lastError: 'TOML 解析失败' }, false)).toBeNull()
  })
})
