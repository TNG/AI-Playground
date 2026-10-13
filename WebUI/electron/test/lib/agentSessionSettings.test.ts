import { describe, expect, it } from 'vitest'
import {
  sessionSettingsFromBag,
  sessionSettingsToBag,
  updateSessionSettingsFromBag,
  usesSessionSettings,
  withoutSessionOwnedKeys,
} from '@/lib/agentSessionSettings'

describe('usesSessionSettings', () => {
  it('is true for the Agent preset only', () => {
    expect(usesSessionSettings({ name: 'Agent', agentPreset: true })).toBe(true)
    expect(usesSessionSettings({ name: 'Game Agent', agentPreset: true })).toBe(false)
    expect(usesSessionSettings({ name: 'Quick Coder', agentPreset: true })).toBe(false)
    expect(usesSessionSettings({ name: 'Assistant' })).toBe(false)
    expect(usesSessionSettings(null)).toBe(false)
  })
})

describe('Session Settings ↔ settings bag', () => {
  it('reads the backend and the model selected for that backend', () => {
    const bag = {
      backend: 'openVINO',
      selectedModels: { llamaCPP: 'Qwen3-9B', openVINO: 'Phi-4', cloud: null },
      contextSize: 8192,
    }
    expect(sessionSettingsFromBag(bag)).toEqual({ backend: 'openVINO', model: 'Phi-4' })
  })

  it('leaves the model out while none is selected for the backend', () => {
    expect(
      sessionSettingsFromBag({ backend: 'llamaCPP', selectedModels: { llamaCPP: null } }),
    ).toEqual({ backend: 'llamaCPP' })
  })

  it('writes the session model into the backend slot, keeping the other backends', () => {
    const bag = sessionSettingsToBag(
      { backend: 'llamaCPP', model: 'Qwen3-9B' },
      { selectedModels: { llamaCPP: 'Other', openVINO: 'Phi-4' }, contextSize: 4096 },
    )
    expect(bag).toEqual({
      backend: 'llamaCPP',
      selectedModels: { llamaCPP: 'Qwen3-9B', openVINO: 'Phi-4' },
      contextSize: 4096,
    })
  })

  it('drops the keys a session owns, so editing a session never rewrites the defaults', () => {
    expect(
      withoutSessionOwnedKeys({
        backend: 'llamaCPP',
        selectedModels: { llamaCPP: 'X' },
        contextSize: 4096,
      }),
    ).toEqual({ contextSize: 4096 })
  })

  it('clears a model that no longer matches the backend after a backend change', () => {
    const next = updateSessionSettingsFromBag(
      { backend: 'llamaCPP', model: 'Qwen3-9B', thinkingEnabled: false },
      { backend: 'openVINO', selectedModels: { llamaCPP: 'Qwen3-9B', openVINO: null } },
    )
    expect(next).toEqual({ backend: 'openVINO', thinkingEnabled: false })
  })
})
