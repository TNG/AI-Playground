import { describe, expect, it } from 'vitest'
import { HARNESS_CHAT_PRESET, isHarnessChatPreset } from '@/lib/harnessChatPreset'

describe('the general harness chat preset', () => {
  it('is still Agent Maker, whose identity is Agent', () => {
    expect(HARNESS_CHAT_PRESET).toBe('Agent')
  })

  it('is told apart from the games presets and plain chat', () => {
    expect(isHarnessChatPreset('Agent')).toBe(true)
    expect(isHarnessChatPreset('Game Agent')).toBe(false)
    expect(isHarnessChatPreset('Quick Coder')).toBe(false)
    expect(isHarnessChatPreset('Assistant')).toBe(false)
    expect(isHarnessChatPreset(undefined)).toBe(false)
    expect(isHarnessChatPreset(null)).toBe(false)
  })
})
