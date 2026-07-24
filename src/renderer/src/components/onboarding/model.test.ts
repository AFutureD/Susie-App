import { describe, expect, it } from 'vitest'
import { configSchema, type Config } from '../../../../shared/config'
import { onboardingStepFor } from './model'

const emptyConfig = configSchema.parse({})

function configWith(partial: Record<string, unknown>): Config {
  return configSchema.parse({
    channels: { my_bot: { type: 'telegram_bot', token: '1:x' } },
    bindings: [{ channel: 'my_bot', assistant_id: 'default' }],
    users: [{ channel: 'my_bot', user_id: '900', role: 'owner' }],
    ...partial,
  })
}

describe('onboardingStepFor', () => {
  it('空配置 → 第 1 步（添加频道）', () => {
    expect(onboardingStepFor({ config: emptyConfig, lastError: null }, false)).toBe('channel')
  })

  it('有频道但无 owner → 第 2 步（绑定 owner）', () => {
    expect(onboardingStepFor({ config: configWith({ users: [], bindings: [] }), lastError: null }, false)).toBe('owner')
    // owner 属于其他频道也算无 owner
    expect(
      onboardingStepFor(
        {
          config: configWith({ users: [{ channel: 'other', user_id: '1', role: 'owner' }], bindings: [] }),
          lastError: null,
        },
        false,
      ),
    ).toBe('owner')
    // 仅有普通用户不算 owner
    expect(
      onboardingStepFor(
        {
          config: configWith({ users: [{ channel: 'my_bot', user_id: '1', role: 'user' }], bindings: [] }),
          lastError: null,
        },
        false,
      ),
    ).toBe('owner')
  })

  it('有频道与 owner 但无绑定 → 第 3 步（会话绑定，覆盖中途退出恢复）', () => {
    expect(onboardingStepFor({ config: configWith({ bindings: [] }), lastError: null }, false)).toBe('binding')
  })

  it('频道、owner 与绑定齐备 → 不显示', () => {
    expect(onboardingStepFor({ config: configWith({}), lastError: null }, false)).toBeNull()
  })

  it('已完成标记 → 任何配置都不显示', () => {
    expect(onboardingStepFor({ config: emptyConfig, lastError: null }, true)).toBeNull()
  })

  it('配置损坏（last-good 运行）→ 不显示，避免误判未配置', () => {
    expect(onboardingStepFor({ config: emptyConfig, lastError: 'TOML 解析失败' }, false)).toBeNull()
  })
})
