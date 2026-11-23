import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUiPresetSchema } from '@/lib/presetSchemas'
import { requiredModelToComfyUIName } from '@/lib/comfyWorkflow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const presetPath = path.resolve(__dirname, '../../../../modes/base/presets/remove-background.json')
const modelConfigPath = path.resolve(__dirname, '../../../external/model_config.json')

const preset = ComfyUiPresetSchema.parse(JSON.parse(readFileSync(presetPath, 'utf-8')))
const modelPaths = JSON.parse(readFileSync(modelConfigPath, 'utf-8')) as Record<string, string>
const workflow = preset.comfyUiApiWorkflow

const sourceOf = (nodeId: string, input: string) => {
  const link = workflow[nodeId].inputs[input] as [string, number]
  return workflow[link[0]]
}

describe('Remove Background preset', () => {
  it('saves the input image with the foreground as its alpha channel', () => {
    const [saveId] = Object.entries(workflow).find(([, node]) => node.class_type === 'SaveImage')!
    const join = sourceOf(saveId, 'images')
    expect(join.class_type).toBe('JoinImageWithAlpha')

    const joinId = Object.keys(workflow).find((id) => workflow[id] === join)!
    expect(sourceOf(joinId, 'image').class_type).toBe('LoadImage')

    // RemoveBackground yields 1 = foreground, while JoinImageWithAlpha treats its mask as 1 = transparent.
    const invert = sourceOf(joinId, 'alpha')
    expect(invert.class_type).toBe('InvertMask')
    const invertId = Object.keys(workflow).find((id) => workflow[id] === invert)!
    expect(sourceOf(invertId, 'mask').class_type).toBe('RemoveBackground')
  })

  it('has a configured model directory for every required model type', () => {
    const missing = (preset.requiredModels ?? [])
      .map((model) => model.type)
      .filter((type) => !(type in modelPaths))

    expect(missing).toEqual([])
  })

  it('points the loader at the downloaded model path', () => {
    const loader = Object.values(workflow).find(
      (node) => node.class_type === 'LoadBackgroundRemovalModel',
    )!

    expect(loader.inputs.bg_removal_name).toBe(
      requiredModelToComfyUIName(preset.requiredModels![0].model),
    )
  })
})
