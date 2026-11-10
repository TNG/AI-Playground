import { describe, expect, it } from 'vitest'
import { HARNESS_CHAT_PRESET, isHarnessChatPreset } from '@/lib/harnessChatPreset'
import { currentPresetName } from '@/lib/presetRenames'

describe('the general harness chat preset', () => {
  it('is Assistant', () => {
    expect(HARNESS_CHAT_PRESET).toBe('Assistant')
  })

  it("is where Agent Maker's stored identity resolves", () => {
    expect(currentPresetName('Agent')).toBe('Assistant')
  })

  it('is told apart from the games presets', () => {
    expect(isHarnessChatPreset('Assistant')).toBe(true)
    expect(isHarnessChatPreset('Game Agent')).toBe(false)
    expect(isHarnessChatPreset('Quick Coder')).toBe(false)
    expect(isHarnessChatPreset(undefined)).toBe(false)
    expect(isHarnessChatPreset(null)).toBe(false)
  })
})
