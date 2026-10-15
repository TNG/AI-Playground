import { describe, expect, it } from 'vitest'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import { PresetSchema, type Preset } from '@/lib/presetSchemas'
import {
  modelKey,
  modelsToDownload,
  taskModelNeeds,
  taskModelWarnings,
  type ModelRef,
  type TaskModelNeeds,
  type TaskModelNeedsInput,
} from '@/lib/taskModelNeeds'

const EMBEDDING = 'ChristianAzinn/bge-small-en-v1.5-gguf/bge-small-en-v1.5.Q8_0.gguf'

function input(
  template: AgentSessionSettings,
  rest: Partial<TaskModelNeedsInput> = {},
): TaskModelNeedsInput {
  return {
    template,
    embedding: { backend: 'llamaCPP', model: EMBEDDING },
    workflows: [],
    speech: {},
    ...rest,
  }
}

describe('taskModelNeeds', () => {
  it('certainly needs the embedding model when document search is on', () => {
    const needs = taskModelNeeds(input({ capabilities: ['rag'] }))
    expect(needs.certain).toEqual([
      {
        kind: 'embedding',
        models: [{ repo_id: EMBEDDING, type: 'embedding', backend: 'llama_cpp' }],
      },
    ])
    expect(needs.maybe).toEqual([])
  })

  it('needs no embedding model without document search', () => {
    expect(taskModelNeeds(input({ capabilities: ['web'] })).certain).toEqual([])
  })
})

function comfy(
  name: string,
  toolCategory: string,
  models: string[],
  extra: Record<string, unknown> = {},
): Preset {
  return PresetSchema.parse({
    type: 'comfy',
    backend: 'comfyui',
    comfyUiApiWorkflow: {},
    name,
    toolCategory,
    requiredModels: models.map((model) => ({ type: 'unet', model })),
    ...extra,
  })
}

const DRAFT_IMAGE = comfy('Draft Image', 'create-images', ['base/sdxl.safetensors'], {
  variants: [
    { name: 'Standard', overrides: { requiredModels: [{ type: 'unet', model: 'std/x' }] } },
    {
      name: 'Fast',
      overrides: {
        requiredModels: [{ type: 'unet', model: 'fast/lcm', additionalLicenceLink: 'https://lic' }],
      },
    },
  ],
})
const HD_IMAGE = comfy('HD Image', 'create-images', ['hd/flux'])
const WAN_VIDEO = comfy('Wan Video', 'create-videos', ['wan/t2v'], { mediaType: 'video' })
const EDIT_BY_PROMPT = comfy('Edit By Prompt', 'edit-images', ['edit/kontext'])
const ANIMATE = comfy('Animate', 'edit-images', ['wan/i2v'], { mediaType: 'video' })
const TO_3D = comfy('Image To 3D Model', 'edit-images', [], { mediaType: 'model3d' })
const WORKFLOWS = [HD_IMAGE, DRAFT_IMAGE, WAN_VIDEO, EDIT_BY_PROMPT, ANIMATE, TO_3D]

const comfyModel = (repo_id: string, additionalLicenseLink?: string): ModelRef => ({
  repo_id,
  type: 'unet',
  backend: 'comfyui',
  ...(additionalLicenseLink ? { additionalLicenseLink } : {}),
})

describe('taskModelNeeds for media', () => {
  it('might need the models of each media slot’s default workflow, in its Fast variant', () => {
    const needs = taskModelNeeds(input({ capabilities: ['media'] }, { workflows: WORKFLOWS }))
    expect(needs.certain).toEqual([])
    expect(needs.maybe).toEqual([
      {
        kind: 'workflow',
        tool: 'comfyUI',
        mediaType: 'image',
        workflow: 'Draft Image',
        models: [comfyModel('fast/lcm', 'https://lic')],
      },
      {
        kind: 'workflow',
        tool: 'comfyUI',
        mediaType: 'video',
        workflow: 'Wan Video',
        models: [comfyModel('wan/t2v')],
      },
      {
        kind: 'workflow',
        tool: 'comfyUiImageEdit',
        mediaType: 'image',
        workflow: 'Edit By Prompt',
        models: [comfyModel('edit/kontext')],
      },
      {
        kind: 'workflow',
        tool: 'comfyUiImageEdit',
        mediaType: 'video',
        workflow: 'Animate',
        models: [comfyModel('wan/i2v')],
      },
    ])
  })

  it('follows the template’s default choice, disabled workflows and disabled tools', () => {
    const template: AgentSessionSettings = {
      capabilities: ['media'],
      builtinToolDefaultPresets: { 'comfyUI:image': 'HD Image' },
      builtinToolPresetEnablement: { 'Wan Video': false },
      builtinToolEnablement: { comfyUiImageEdit: false },
    }
    const needs = taskModelNeeds(input(template, { workflows: WORKFLOWS }))
    expect(needs.maybe).toEqual([
      {
        kind: 'workflow',
        tool: 'comfyUI',
        mediaType: 'image',
        workflow: 'HD Image',
        models: [comfyModel('hd/flux')],
      },
    ])
  })

  it('leaves out text to video without delegation, where generateImage offers no video', () => {
    const needs = taskModelNeeds(
      input({ capabilities: ['media'], toolDelegationEnabled: false }, { workflows: WORKFLOWS }),
    )
    expect(needs.maybe.map((need) => need.kind === 'workflow' && need.workflow)).toEqual([
      'Draft Image',
      'Edit By Prompt',
      'Animate',
    ])
  })

  it('might need the speech engines’ models for the enabled speech tools', () => {
    const tts: ModelRef = {
      repo_id: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
      type: 'TTS',
      backend: 'openvino',
    }
    const stt: ModelRef = {
      repo_id: 'OpenVINO/whisper-base-int8-ov',
      type: 'STT',
      backend: 'openvino',
    }
    const speech = { synthesizeTextToSpeech: tts, transcribeAudio: stt } as const
    const both = taskModelNeeds(input({ capabilities: ['media'] }, { speech }))
    expect(both.maybe).toEqual([
      { kind: 'speech', tool: 'synthesizeTextToSpeech', models: [tts] },
      { kind: 'speech', tool: 'transcribeAudio', models: [stt] },
    ])
    const sttOff = taskModelNeeds(
      input(
        { capabilities: ['media'], builtinToolEnablement: { transcribeAudio: false } },
        { speech },
      ),
    )
    expect(sttOff.maybe).toEqual([
      { kind: 'speech', tool: 'synthesizeTextToSpeech', models: [tts] },
    ])
    expect(taskModelNeeds(input({ capabilities: ['web'] }, { speech })).maybe).toEqual([])
  })

  it('might need nothing for media without the media capability', () => {
    expect(
      taskModelNeeds(input({ capabilities: ['rag'] }, { workflows: WORKFLOWS })).maybe,
    ).toEqual([])
  })
})

describe('taskModelWarnings', () => {
  const needs: TaskModelNeeds = {
    certain: [
      {
        kind: 'embedding',
        models: [{ repo_id: EMBEDDING, type: 'embedding', backend: 'llama_cpp' }],
      },
    ],
    maybe: [
      {
        kind: 'workflow',
        tool: 'comfyUI',
        mediaType: 'image',
        workflow: 'Draft Image',
        models: [comfyModel('fast/lcm'), comfyModel('shared/vae')],
      },
      {
        kind: 'workflow',
        tool: 'comfyUiImageEdit',
        mediaType: 'image',
        workflow: 'Edit By Prompt',
        models: [comfyModel('shared/vae')],
      },
      {
        kind: 'workflow',
        tool: 'comfyUI',
        mediaType: 'video',
        workflow: 'Wan Video',
        models: [comfyModel('wan/t2v')],
      },
    ],
  }

  it('keeps only the missing models, with their sizes where known, and drops needs fully met', () => {
    const missing = new Set([modelKey(comfyModel('shared/vae')), modelKey(comfyModel('fast/lcm'))])
    const warnings = taskModelWarnings(needs, missing, {
      [modelKey(comfyModel('shared/vae'))]: '320.00M',
    })
    expect(warnings.certain).toEqual([])
    expect(warnings.maybe).toEqual([
      {
        kind: 'workflow',
        tool: 'comfyUI',
        mediaType: 'image',
        workflow: 'Draft Image',
        models: [comfyModel('fast/lcm'), { ...comfyModel('shared/vae'), size: '320.00M' }],
      },
      {
        kind: 'workflow',
        tool: 'comfyUiImageEdit',
        mediaType: 'image',
        workflow: 'Edit By Prompt',
        models: [{ ...comfyModel('shared/vae'), size: '320.00M' }],
      },
    ])
  })

  it('lists a model shared by several needs once for downloading', () => {
    const missing = new Set([modelKey(comfyModel('shared/vae')), modelKey(comfyModel('fast/lcm'))])
    const warnings = taskModelWarnings(needs, missing, {})
    expect(modelsToDownload(warnings.maybe)).toEqual([
      comfyModel('fast/lcm'),
      comfyModel('shared/vae'),
    ])
  })
})
