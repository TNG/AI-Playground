import { describe, expect, it } from 'vitest'
import { agentBackendChoices, contextSizeSettingSupported } from '@/lib/llmBackendChoices'

describe('agentBackendChoices', () => {
  it('offers both local backends when the preset names none', () => {
    expect(
      agentBackendChoices({
        presetBackends: undefined,
        productMode: 'studio',
        cloudEnabled: false,
      }),
    ).toEqual(['llamaCPP', 'openVINO'])
  })

  it("offers the preset's backends", () => {
    expect(
      agentBackendChoices({
        presetBackends: ['llamaCPP'],
        productMode: 'studio',
        cloudEnabled: false,
      }),
    ).toEqual(['llamaCPP'])
  })

  it('drops OpenVINO in nvidia product mode', () => {
    expect(
      agentBackendChoices({
        presetBackends: undefined,
        productMode: 'nvidia',
        cloudEnabled: false,
      }),
    ).toEqual(['llamaCPP'])
  })

  it('adds cloud last when Cloud Mode is enabled', () => {
    expect(
      agentBackendChoices({
        presetBackends: ['openVINO'],
        productMode: 'studio',
        cloudEnabled: true,
      }),
    ).toEqual(['openVINO', 'cloud'])
  })

  it('offers cloud only when Cloud Mode is enabled, even if the preset lists it', () => {
    expect(
      agentBackendChoices({
        presetBackends: ['cloud', 'llamaCPP'],
        productMode: 'studio',
        cloudEnabled: false,
      }),
    ).toEqual(['llamaCPP'])
    expect(
      agentBackendChoices({
        presetBackends: ['cloud', 'llamaCPP'],
        productMode: 'studio',
        cloudEnabled: true,
      }),
    ).toEqual(['llamaCPP', 'cloud'])
  })
})

describe('contextSizeSettingSupported', () => {
  it('is supported on llama.cpp and on OpenVINO only when it runs on an NPU', () => {
    expect(contextSizeSettingSupported('llamaCPP', false)).toBe(true)
    expect(contextSizeSettingSupported('openVINO', true)).toBe(true)
    expect(contextSizeSettingSupported('openVINO', false)).toBe(false)
    expect(contextSizeSettingSupported('cloud', false)).toBe(false)
  })
})
