import type { Model } from '@susie/codex-app-server'
import { describe, expect, it } from 'vitest'
import { mapAppServerModels } from './codex-models'

function model(partial: Partial<Model>): Model {
  return {
    id: partial.model ?? '',
    model: '',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: '',
    description: '',
    hidden: false,
    supportedReasoningEfforts: [],
    defaultReasoningEffort: 'medium',
    inputModalities: [],
    supportsPersonality: false,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: false,
    ...partial,
  }
}

describe('mapAppServerModels', () => {
  it('maps model/list data, skipping hidden and malformed entries', () => {
    const data = [
      model({ model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'Latest frontier model.' }),
      model({ model: 'gpt-5.6-hidden', displayName: 'Hidden', description: 'x', hidden: true }),
      model({ displayName: 'no-model-field' }),
      model({ model: 'bare' }),
    ]
    expect(mapAppServerModels(data)).toEqual([
      { value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Latest frontier model.' },
      { value: 'bare', name: 'bare' },
    ])
  })

  it('returns empty for empty data', () => {
    expect(mapAppServerModels([])).toEqual([])
  })
})
