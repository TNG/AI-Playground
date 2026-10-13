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
      temperature: 0.7,
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
        selectedDeviceId: 'GPU.0',
        selectedDeviceUuid: 'u-arc',
        selectedEmbeddingModels: { llamaCPP: 'bge' },
        contextSize: 4096,
        requestedContextSize: 4096,
        contextSizeEdited: true,
        thinkingEnabled: false,
        toolDelegationEnabled: true,
        builtinToolEnablement: {},
        builtinToolPresetEnablement: {},
        builtinToolDefaultPresets: {},
        cloudProviderId: 'zai',
        temperature: 0.7,
      }),
    ).toEqual({ temperature: 0.7 })
  })

  it('clears a model that no longer matches the backend after a backend change', () => {
    const next = updateSessionSettingsFromBag(
      { backend: 'llamaCPP', model: 'Qwen3-9B', capabilities: ['web'] },
      { backend: 'openVINO', selectedModels: { llamaCPP: 'Qwen3-9B', openVINO: null } },
    )
    expect(next).toEqual({ backend: 'openVINO', capabilities: ['web'] })
  })

  const fullBag = {
    backend: 'llamaCPP',
    selectedModels: { llamaCPP: 'Qwen3-9B', openVINO: 'Phi-4' },
    selectedDeviceId: 'GPU.1',
    selectedDeviceUuid: 'u-igpu',
    selectedEmbeddingModels: { llamaCPP: 'bge-small', openVINO: 'bge-ov' },
    contextSize: 16384,
    requestedContextSize: 65536,
    contextSizeEdited: true,
    thinkingEnabled: false,
    toolDelegationEnabled: false,
    builtinToolEnablement: { captureScreenshot: true },
    builtinToolPresetEnablement: { Flux: false },
    builtinToolDefaultPresets: { 'comfyUI:image': 'Z-Image' },
    cloudProviderId: 'zai',
    temperature: 0.7,
  }
  const fullSettings = {
    backend: 'llamaCPP',
    model: 'Qwen3-9B',
    device: { id: 'GPU.1', uuid: 'u-igpu' },
    embeddingModel: 'bge-small',
    contextSize: 65536,
    contextSizeEdited: true,
    thinkingEnabled: false,
    toolDelegationEnabled: false,
    builtinToolEnablement: { captureScreenshot: true },
    builtinToolPresetEnablement: { Flux: false },
    builtinToolDefaultPresets: { 'comfyUI:image': 'Z-Image' },
    cloudProviderId: 'zai',
  }

  it('reads every model setting, keeping the context size the user asked for', () => {
    expect(sessionSettingsFromBag(fullBag, 'llamaCPP')).toEqual(fullSettings)
  })

  it('reads the embedding model of the embedding backend, which a cloud session keeps local', () => {
    const settings = sessionSettingsFromBag({ ...fullBag, backend: 'cloud' }, 'openVINO')
    expect(settings.embeddingModel).toBe('bge-ov')
  })

  it('lays every model setting over the defaults so the chat store can load it', () => {
    const bag = sessionSettingsToBag(
      fullSettings as never,
      { selectedEmbeddingModels: { openVINO: 'bge-ov' }, temperature: 0.2 },
      'llamaCPP',
    )
    expect(bag).toMatchObject({
      backend: 'llamaCPP',
      selectedDeviceId: 'GPU.1',
      selectedDeviceUuid: 'u-igpu',
      selectedEmbeddingModels: { llamaCPP: 'bge-small', openVINO: 'bge-ov' },
      contextSize: 65536,
      requestedContextSize: 65536,
      contextSizeEdited: true,
      thinkingEnabled: false,
      toolDelegationEnabled: false,
      builtinToolEnablement: { captureScreenshot: true },
      cloudProviderId: 'zai',
      temperature: 0.2,
    })
  })

  it('round-trips: what is laid into the bag reads back unchanged', () => {
    const bag = sessionSettingsToBag(fullSettings as never, {}, 'llamaCPP')
    expect(sessionSettingsFromBag(bag, 'llamaCPP')).toEqual(fullSettings)
  })
})
