import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyVariant,
  ComfyUiPresetSchema,
  type ComfyUIApiWorkflow,
  type ComfyUiPreset,
} from '@/lib/presetSchemas'
import { modifySettingInWorkflow, requiredModelToComfyUIName } from '@/lib/comfyWorkflow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const presetsDir = path.resolve(__dirname, '../../../../modes/base/presets')
const modelConfigPath = path.resolve(__dirname, '../../../external/model_config.json')
const modelPaths = JSON.parse(readFileSync(modelConfigPath, 'utf-8')) as Record<string, string>

const load = (file: string) =>
  ComfyUiPresetSchema.parse(JSON.parse(readFileSync(path.join(presetsDir, file), 'utf-8')))

const presets = {
  image: load('minimax-h3-image.json'),
  edit: load('minimax-h3-edit.json'),
  video: load('minimax-h3-video.json'),
  i2v: load('minimax-h3-i2v.json'),
}

const resolvedPresets = (preset: ComfyUiPreset): ComfyUiPreset[] =>
  preset.variants?.length
    ? preset.variants.map((v) => applyVariant(preset, v.name) as ComfyUiPreset)
    : [preset]

type WorkflowNode = { inputs: Record<string, unknown>; _meta?: { title?: string } }

const nodeByTitle = (preset: ComfyUiPreset, title: string) =>
  (Object.values(preset.comfyUiApiWorkflow) as WorkflowNode[]).find(
    (node) => node._meta?.title === title,
  )

const inputsOf = (workflow: ComfyUIApiWorkflow, id: string) =>
  (workflow[id] as WorkflowNode | undefined)?.inputs ?? {}

const settingDefault = (preset: ComfyUiPreset, name: string) => {
  const setting = preset.settings.find((s) => 'settingName' in s && s.settingName === name)
  return setting && 'defaultValue' in setting ? setting.defaultValue : undefined
}

describe('MiniMax H3 presets', () => {
  it('take over the Pro 3 Image slot and keep ERNIE as its own preset', () => {
    expect(presets.image.name).toBe('Pro 3 Image')
    const ernie = load('ERNIE-Image.json')
    expect(ernie.name).toBe('ERNIE Image')
    expect(ernie.displayPriority).toBeGreaterThan(presets.image.displayPriority ?? 0)
  })

  it.each(Object.entries(presets))('%s drops --lowvram from the ComfyUI launch', (_, preset) => {
    expect(preset.droppedComfyUiParameters).toEqual(['--lowvram'])
  })

  it.each(Object.entries(presets))(
    '%s has a model directory and a matching loader for every required model',
    (_, preset) => {
      for (const resolved of resolvedPresets(preset)) {
        const loaderNames = new Set<string>(
          Object.values(resolved.comfyUiApiWorkflow).flatMap((node) =>
            Object.entries(node.inputs ?? {})
              .filter(([name, value]) => name.endsWith('_name') && typeof value === 'string')
              .map(([, value]) => value as string),
          ),
        )
        for (const { type, model } of resolved.requiredModels ?? []) {
          expect(modelPaths, type).toHaveProperty(type)
          if (type === 'nsfwdetector') continue
          expect(loaderNames, model).toContain(requiredModelToComfyUIName(model))
        }
      }
    },
  )

  it.each(Object.entries(presets))(
    '%s writes the prompt into the H3 conditioning node',
    (_, preset) => {
      const workflow = structuredClone(preset.comfyUiApiWorkflow)
      modifySettingInWorkflow(workflow, 'prompt', 'a red fox')
      expect(
        nodeByTitle({ ...preset, comfyUiApiWorkflow: workflow }, 'prompt')?.inputs.prompt,
      ).toBe('a red fox')
    },
  )

  it('defaults Pro 3 Image to 4096x4096 (16MP)', () => {
    expect(settingDefault(presets.image, 'width')).toBe(4096)
    expect(settingDefault(presets.image, 'height')).toBe(4096)
    const workflow = structuredClone(presets.image.comfyUiApiWorkflow)
    modifySettingInWorkflow(workflow, 'width', 2720)
    modifySettingInWorkflow(workflow, 'height', 1536)
    expect(inputsOf(workflow, '5')).toMatchObject({ width: 2720, height: 1536 })
  })

  it('sizes the edit from the rescaled source image, not from a width setting', () => {
    const workflow = structuredClone(presets.edit.comfyUiApiWorkflow)
    modifySettingInWorkflow(workflow, 'width', 512)
    modifySettingInWorkflow(workflow, 'height', 512)
    expect(inputsOf(workflow, '5')).toMatchObject({
      width: ['12', 0],
      height: ['12', 1],
      'images.image_1': ['11', 0],
    })
    expect(nodeByTitle(presets.edit, 'Output Megapixels')?.inputs.megapixels).toBe(16)
  })

  it('runs the Turbo LoRA at 8 steps and Standard at 20 without it', () => {
    for (const preset of [presets.video, presets.i2v]) {
      expect(preset.variants?.[0]?.name).toBe('Turbo')
      const turbo = applyVariant(preset, 'Turbo') as ComfyUiPreset
      const standard = applyVariant(preset, 'Standard') as ComfyUiPreset
      expect(settingDefault(turbo, 'inferenceSteps')).toBe(8)
      expect(inputsOf(turbo.comfyUiApiWorkflow, '10')).toMatchObject({ steps: 8, model: ['20', 0] })
      expect(inputsOf(turbo.comfyUiApiWorkflow, '7').model).toEqual(['20', 0])
      expect(settingDefault(standard, 'inferenceSteps')).toBe(20)
      expect(standard.comfyUiApiWorkflow['20']).toBeUndefined()
      expect(inputsOf(standard.comfyUiApiWorkflow, '10').model).toEqual(['1', 0])
    }
  })

  it('keeps the default video length on the 17k+5 frame grid', () => {
    for (const preset of [presets.video, presets.i2v]) {
      const frames = preset.settings.find((s) => s.label === 'Total Frames')
      const length = nodeByTitle(preset, 'Length')?.inputs.value as number
      expect(frames && 'defaultValue' in frames ? frames.defaultValue : undefined).toBe(length)
      expect((length - 5) % 17).toBe(0)
    }
  })

  it('writes text-to-video width and height into the conditioning node', () => {
    const workflow = structuredClone(presets.video.comfyUiApiWorkflow)
    modifySettingInWorkflow(workflow, 'width', 1344)
    modifySettingInWorkflow(workflow, 'height', 768)
    expect(inputsOf(workflow, '5')).toMatchObject({ width: 1344, height: 768 })
  })

  it('crops the image-to-video first frame to the same size the video is rendered at', () => {
    const workflow = structuredClone(presets.i2v.comfyUiApiWorkflow)
    modifySettingInWorkflow(workflow, 'width', 768)
    modifySettingInWorkflow(workflow, 'height', 1344)
    expect(inputsOf(workflow, '18').a).toBe(768)
    expect(inputsOf(workflow, '19').a).toBe(1344)
    expect(inputsOf(workflow, '5')).toMatchObject({
      width: ['18', 0],
      height: ['19', 0],
      first_frame: ['17', 0],
    })
    expect(inputsOf(workflow, '17')).toMatchObject({
      crop: 'center',
      width: ['18', 0],
      height: ['19', 0],
    })
  })
})
