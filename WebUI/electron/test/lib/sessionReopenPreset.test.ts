import { describe, expect, it } from 'vitest'
import { sessionReopenPreset } from '@/lib/sessionReopenPreset'

const known = ['Assistant', 'Flux']

describe('the preset a Session reopens on', () => {
  it('is the preset and variant of its last turn', () => {
    expect(sessionReopenPreset({ preset: 'Flux', variant: 'fast' }, known, undefined)).toEqual({
      preset: 'Flux',
      variant: 'fast',
    })
  })

  it('is nothing for a Session with no turns', () => {
    expect(sessionReopenPreset(null, known, 'agent-1')).toBeNull()
  })

  it('is Assistant when the last turn ran on Agent Maker', () => {
    expect(sessionReopenPreset({ preset: 'Agent' }, known, undefined)).toEqual({
      preset: 'Assistant',
    })
  })

  it('is Assistant when the last turn’s preset is gone and an Agent is picked', () => {
    expect(sessionReopenPreset({ preset: 'Morning news' }, known, 'agent-1')).toEqual({
      preset: 'Assistant',
    })
  })

  it('is nothing when the last turn’s preset is gone and no Agent is picked', () => {
    expect(sessionReopenPreset({ preset: 'Morning news' }, known, undefined)).toBeNull()
  })
})
