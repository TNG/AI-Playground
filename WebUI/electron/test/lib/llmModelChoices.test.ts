import { describe, expect, it } from 'vitest'
import {
  llmModelChoices,
  modelSupportsThinkingToggle,
  type ModelChoiceContext,
} from '@/lib/llmModelChoices'

type Model = Parameters<typeof llmModelChoices>[0][number] & { supportsThinkingToggle?: boolean }

const model = (name: string, overrides: Partial<Model> = {}): Model => ({
  name,
  type: 'llamaCPP',
  isPredefined: true,
  ...overrides,
})

const context = (overrides: Partial<ModelChoiceContext> = {}): ModelChoiceContext => ({
  backend: 'llamaCPP',
  preset: null,
  onNpu: false,
  phisonSsdDetected: false,
  ...overrides,
})

const names = (models: Model[]) => models.map((m) => m.name)

describe('llmModelChoices', () => {
  it("offers only the backend's models, favorites first", () => {
    const models = [
      model('a'),
      model('ov', { type: 'openVINO' }),
      model('b', { favorite: true }),
      model('c'),
    ]
    expect(names(llmModelChoices(models, context()))).toEqual(['b', 'a', 'c'])
  })

  it("keeps only models that meet the preset's requirements", () => {
    const models = [
      model('agentic-tools', { supportsAgentic: true, supportsToolCalling: true }),
      model('tools-only', { supportsToolCalling: true }),
      model('plain'),
    ]
    const preset = { type: 'chat', requiresToolCalling: true, requiresAgentic: true } as const
    expect(names(llmModelChoices(models, context({ preset })))).toEqual(['agentic-tools'])
  })

  it("offers a custom model only when it matches one of the preset's requirements", () => {
    const models = [
      model('custom-tools', { isPredefined: false, supportsToolCalling: true }),
      model('custom-plain', { isPredefined: false }),
    ]
    const preset = { type: 'chat', requiresToolCalling: true } as const
    expect(names(llmModelChoices(models, context({ preset })))).toEqual(['custom-tools'])
    expect(
      names(llmModelChoices(models, context({ preset: { ...preset, advancedMode: true } }))),
    ).toEqual(['custom-tools'])
    expect(
      names(llmModelChoices(models, context({ preset: { type: 'chat', advancedMode: true } }))),
    ).toEqual(['custom-tools', 'custom-plain'])
  })

  it('offers a basic custom model to a text-only preset, but no vision or reasoning model', () => {
    const models = [
      model('custom-basic', { isPredefined: false }),
      model('vision', { supportsVision: true }),
      model('reasoning', { supportsReasoning: true }),
      model('basic'),
    ]
    const preset = { type: 'chat', filterTxt2TxtOnly: true } as const
    expect(names(llmModelChoices(models, context({ preset })))).toEqual(['custom-basic', 'basic'])
  })

  it('offers NPU models on an NPU device and the others on any other OpenVINO device', () => {
    const models = [
      model('npu', { type: 'openVINO', npuSupport: true }),
      model('gpu', { type: 'openVINO' }),
    ]
    expect(names(llmModelChoices(models, context({ backend: 'openVINO', onNpu: true })))).toEqual([
      'npu',
    ])
    expect(names(llmModelChoices(models, context({ backend: 'openVINO', onNpu: false })))).toEqual([
      'gpu',
    ])
  })

  it('offers a model that needs a Phison SSD only once one is detected', () => {
    const models = [model('huge', { requiresPhison: true }), model('small')]
    expect(names(llmModelChoices(models, context()))).toEqual(['small'])
    expect(names(llmModelChoices(models, context({ phisonSsdDetected: true })))).toEqual([
      'huge',
      'small',
    ])
  })

  it('keeps only large MoE models for a preset that asks for them', () => {
    const models = [model('moe', { largeMoe: true }), model('dense')]
    const preset = { type: 'chat', filterLargeMoeOnly: true } as const
    expect(names(llmModelChoices(models, context({ preset })))).toEqual(['moe'])
  })

  it('offers every cloud model whatever the preset requires', () => {
    const models = [model('remote', { type: 'cloud', isPredefined: false })]
    const preset = { type: 'chat', requiresToolCalling: true, requiresAgentic: true } as const
    expect(names(llmModelChoices(models, context({ backend: 'cloud', preset })))).toEqual([
      'remote',
    ])
  })

  it('ignores the requirements of a preset that is not a chat preset', () => {
    const models = [model('plain'), model('custom', { isPredefined: false })]
    const preset = { type: 'comfy', requiresToolCalling: true } as const
    expect(names(llmModelChoices(models, context({ preset })))).toEqual(['plain'])
  })
})

describe('modelSupportsThinkingToggle', () => {
  const models = [
    model('qwen', { supportsThinkingToggle: true }),
    model('qwen', { type: 'openVINO' }),
    model('plain'),
  ]

  it('follows the given model on the given backend', () => {
    expect(modelSupportsThinkingToggle(models, 'llamaCPP', 'qwen')).toBe(true)
    expect(modelSupportsThinkingToggle(models, 'openVINO', 'qwen')).toBe(false)
    expect(modelSupportsThinkingToggle(models, 'llamaCPP', 'plain')).toBe(false)
  })

  it('is false for no model or an unknown one', () => {
    expect(modelSupportsThinkingToggle(models, 'llamaCPP', undefined)).toBe(false)
    expect(modelSupportsThinkingToggle(models, 'llamaCPP', 'gone')).toBe(false)
  })
})
