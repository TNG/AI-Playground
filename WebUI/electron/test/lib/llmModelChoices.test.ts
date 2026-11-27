import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import z from 'zod'
import { ModelSchema } from '@/types/shared'
import { PresetSchema } from '@/assets/js/store/presets'
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

describe('llmModelChoices for the shipped Assistant', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const catalog: Model[] = z
    .array(ModelSchema)
    .parse(JSON.parse(readFileSync(path.resolve(here, '../../../external/models.json'), 'utf-8')))
    .filter((entry) => entry.type !== 'embedding')
    .map((entry) => ({ ...entry, type: entry.type as Model['type'], isPredefined: true }))
  const userAdded = model('me/my-model-GGUF/my-model.gguf', { isPredefined: false })
  const preset = PresetSchema.parse(
    JSON.parse(
      readFileSync(path.resolve(here, '../../../../modes/base/presets/assistant.json'), 'utf-8'),
    ),
  )
  const offered = (overrides: Partial<ModelChoiceContext>) =>
    names(llmModelChoices([...catalog, userAdded], context({ preset, ...overrides })))

  it('offers every llama.cpp model, the ones not suited to agent work and user-added ones too', () => {
    const choices = offered({ backend: 'llamaCPP' })
    for (const name of [
      'unsloth/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf',
      'unsloth/gpt-oss-20b-GGUF/gpt-oss-20b-Q8_0.gguf',
      'unsloth/Qwen3-VL-4B-Instruct-GGUF/Qwen3-VL-4B-Instruct-Q5_K_S.gguf',
      'unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf',
      userAdded.name,
    ]) {
      expect(choices).toContain(name)
    }
  })

  it('offers Qwen3-8B on an NPU, and the other OpenVINO models elsewhere', () => {
    expect(offered({ backend: 'openVINO', onNpu: true })).toEqual(['OpenVINO/Qwen3-8B-int4-cw-ov'])
    const gpu = offered({ backend: 'openVINO', onNpu: false })
    expect(gpu).toEqual(
      expect.arrayContaining([
        'OpenVINO/Qwen3-VL-8B-Instruct-int4-ov',
        'OpenVINO/gpt-oss-20b-int4-ov',
      ]),
    )
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
