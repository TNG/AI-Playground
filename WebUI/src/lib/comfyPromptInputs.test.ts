import { describe, expect, it } from 'vitest'
import {
  describeWorkflowInputs,
  dynamicInputsSchema,
  isDeviceInput,
  isPromptSelectableInput,
  promptSelectableInputs,
  summarizePromptInput,
} from './comfyPromptInputs'
import type { ComfyInput, ComfyUiPreset } from './presetSchemas'

// The prompt-selectable-input rule is shared between the renderer (tool
// descriptions enumerate the inputs) and main (the merge refuses everything
// else), so it is pinned here once.

function input(overrides: Partial<ComfyInput> & { label: string }): ComfyInput {
  return {
    type: 'number',
    nodeTitle: 'Node',
    nodeInput: 'value',
    displayed: true,
    modifiable: true,
    ...overrides,
  } as ComfyInput
}

function presetWith(settings: Array<Record<string, unknown>>): ComfyUiPreset {
  return {
    type: 'comfy',
    backend: 'comfyui',
    settings,
    comfyUiApiWorkflow: {},
  } as unknown as ComfyUiPreset
}

describe('isDeviceInput', () => {
  it('matches the device input regardless of case or whitespace', () => {
    expect(isDeviceInput(input({ label: 'Device', nodeInput: 'device' }))).toBe(true)
    expect(isDeviceInput(input({ label: 'Device', nodeInput: ' Device ' }))).toBe(true)
    expect(isDeviceInput(input({ label: 'Device', nodeInput: 'DEVICE' }))).toBe(true)
  })

  it('does not match other inputs', () => {
    expect(isDeviceInput(input({ label: 'Guidance Scale', nodeInput: 'guidance' }))).toBe(false)
  })
})

describe('isPromptSelectableInput', () => {
  it('accepts a value-shaped, displayed, modifiable input', () => {
    expect(isPromptSelectableInput(input({ label: 'Guidance Scale' }))).toBe(true)
  })

  it('refuses the device, media-typed and hidden or read-only inputs', () => {
    expect(isPromptSelectableInput(input({ label: 'Device', nodeInput: 'device' }))).toBe(false)
    expect(isPromptSelectableInput(input({ label: 'Image', type: 'image' }))).toBe(false)
    expect(isPromptSelectableInput(input({ label: 'Canvas', type: 'outpaintCanvas' }))).toBe(false)
    expect(isPromptSelectableInput(input({ label: 'Hidden', displayed: false }))).toBe(false)
    expect(isPromptSelectableInput(input({ label: 'Fixed', modifiable: false }))).toBe(false)
  })
})

describe('summarizePromptInput', () => {
  it('describes an option list including its default', () => {
    expect(
      summarizePromptInput(
        input({
          label: 'Sampling Method',
          type: 'string',
          nodeInput: 'sampler',
          options: ['euler', 'dpmpp_2m'],
          defaultValue: 'euler',
        }),
      ),
    ).toEqual({ label: 'Sampling Method', detail: 'one of: euler, dpmpp_2m, default euler' })
  })

  it('describes a ranged number including its default', () => {
    expect(
      summarizePromptInput(input({ label: 'Guidance Scale', defaultValue: 7, min: 1, max: 20 })),
    ).toEqual({ label: 'Guidance Scale', detail: 'number between 1 and 20, default 7' })
  })

  it('describes models and booleans', () => {
    expect(
      summarizePromptInput(input({ label: 'Model', type: 'model', nodeInput: 'ckpt' })),
    ).toEqual({
      label: 'Model',
      detail: 'model name (one of the models available to this workflow)',
    })
    expect(
      summarizePromptInput(input({ label: 'Tile It', type: 'boolean', nodeInput: 'tile' })),
    ).toEqual({ label: 'Tile It', detail: 'true or false' })
  })
})

describe('promptSelectableInputs', () => {
  it('lists only the prompt-selectable ComfyUI inputs, in catalog order', () => {
    const summaries = promptSelectableInputs(
      presetWith([
        {
          type: 'number',
          label: 'seed',
          settingName: 'seed',
          displayed: true,
          modifiable: true,
          defaultValue: 1,
        },
        input({ label: 'Guidance Scale', defaultValue: 7, min: 1, max: 20 }),
        input({ label: 'Device', nodeInput: 'device', type: 'string', defaultValue: 'AUTO' }),
        input({ label: 'Image', type: 'image' }),
        input({
          label: 'Sampling Method',
          type: 'string',
          nodeInput: 'sampler',
          options: ['euler'],
          defaultValue: 'euler',
        }),
      ]),
    )
    expect(summaries.map((s) => s.label)).toEqual(['Guidance Scale', 'Sampling Method'])
  })
})

describe('describeWorkflowInputs', () => {
  it('returns an empty string when no workflow exposes any input', () => {
    expect(describeWorkflowInputs([{ name: 'P' }, { name: 'Q', promptInputs: [] }])).toBe('')
  })

  it('enumerates each workflow with its labeled inputs', () => {
    const section = describeWorkflowInputs([
      {
        name: 'P',
        promptInputs: [{ label: 'Guidance Scale', detail: 'number between 1 and 20, default 7' }],
      },
      { name: 'Q' },
    ])
    expect(section).toContain('WORKFLOW INPUTS')
    expect(section).toContain('- P: Guidance Scale (number between 1 and 20, default 7)')
    expect(section).not.toContain('- Q:')
  })
})

describe('dynamicInputsSchema', () => {
  it('accepts a label-keyed record of primitives', () => {
    expect(
      dynamicInputsSchema.parse({
        'Guidance Scale': 7.5,
        'Sampling Method': 'euler',
        'Tile It': true,
      }),
    ).toEqual({
      'Guidance Scale': 7.5,
      'Sampling Method': 'euler',
      'Tile It': true,
    })
  })

  it('is optional', () => {
    expect(dynamicInputsSchema.parse(undefined)).toBeUndefined()
  })

  it('refuses nested values', () => {
    expect(dynamicInputsSchema.safeParse({ 'Guidance Scale': { nested: true } }).success).toBe(
      false,
    )
  })
})
