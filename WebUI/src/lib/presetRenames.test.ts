import { describe, it, expect } from 'vitest'
import { currentPresetName, renamePresetKeys } from './presetRenames'

describe('currentPresetName', () => {
  it('follows a renamed preset and leaves every other name alone', () => {
    expect(currentPresetName('Game Maker')).toBe('Game Agent')
    expect(currentPresetName('Game Maker Quick')).toBe('Game Agent Quick')
    expect(currentPresetName('Assistant')).toBe('Assistant')
  })
})

describe('renamePresetKeys', () => {
  it('re-keys stored state, variants included', () => {
    expect(
      renamePresetKeys({
        'Game Maker': { temperature: 0.4 },
        'Game Maker Quick:Fast': { temperature: 0.9 },
        Assistant: { temperature: 0.7 },
      }),
    ).toEqual({
      'Game Agent': { temperature: 0.4 },
      'Game Agent Quick:Fast': { temperature: 0.9 },
      Assistant: { temperature: 0.7 },
    })
  })

  it('never overwrites state already stored under the current name', () => {
    expect(renamePresetKeys({ 'Game Maker': 'old', 'Game Agent': 'current' })).toEqual({
      'Game Agent': 'current',
    })
  })

  it('returns the same object when nothing was renamed', () => {
    const entries = { Assistant: 1 }
    expect(renamePresetKeys(entries)).toBe(entries)
  })
})
