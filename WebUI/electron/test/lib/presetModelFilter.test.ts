import { describe, expect, it } from 'vitest'
import { modelMeetsPresetRequirements } from '@/lib/presetModelFilter'

const open = {
  vision: false,
  toolCalling: false,
  reasoning: false,
  coding: false,
  agentic: false,
  npuSupport: false,
}

describe('modelMeetsPresetRequirements', () => {
  it('keeps a model marked agentic or unverified, and drops one marked non-agentic', () => {
    const gate = { ...open, agentic: true }
    expect(modelMeetsPresetRequirements({ supportsAgentic: true }, gate)).toBe(true)
    expect(modelMeetsPresetRequirements({ supportsAgentic: false }, gate)).toBe(false)
    // Unknown agentic is offered (as unverified) rather than hidden.
    expect(modelMeetsPresetRequirements({}, gate)).toBe(true)
  })

  it('requires every gate the preset sets', () => {
    expect(
      modelMeetsPresetRequirements(
        { supportsAgentic: true, supportsCoding: true, supportsToolCalling: true },
        { ...open, agentic: true, coding: true, toolCalling: true },
      ),
    ).toBe(true)
    expect(
      modelMeetsPresetRequirements(
        { supportsAgentic: true, supportsToolCalling: true },
        { ...open, agentic: true, coding: true, toolCalling: true },
      ),
    ).toBe(false)
  })
})
