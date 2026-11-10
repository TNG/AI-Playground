import { describe, expect, it } from 'vitest'
import { HARNESS_CHAT_PRESET, isHarnessChatPreset } from '@/lib/harnessChatPreset'
import { presetDisplayName } from '@/lib/presetDisplayName'
import { currentPresetName } from '@/lib/presetRenames'

describe('the general harness chat preset', () => {
  it('is Assistant, shown under its own name', () => {
    expect(HARNESS_CHAT_PRESET).toBe('Assistant')
    expect(presetDisplayName(HARNESS_CHAT_PRESET)).toBe('Assistant')
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
