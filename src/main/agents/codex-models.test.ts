import { describe, expect, it } from 'vitest'
import { mapAppServerModels } from './codex-models'

describe('mapAppServerModels', () => {
  it('maps model/list data, skipping hidden and malformed entries', () => {
    const data = [
      { model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'Latest frontier model.', hidden: false },
      { model: 'gpt-5.6-hidden', displayName: 'Hidden', description: 'x', hidden: true },
      { displayName: 'no-model-field', hidden: false },
      { model: 'bare', displayName: '', description: '', hidden: false },
    ]
    expect(mapAppServerModels(data)).toEqual([
      { value: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Latest frontier model.' },
      { value: 'bare', name: 'bare' },
    ])
  })

  it('returns empty for non-array payloads', () => {
    expect(mapAppServerModels(undefined)).toEqual([])
    expect(mapAppServerModels({ data: [] })).toEqual([])
  })
})
