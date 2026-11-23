import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyVariant, ComfyUiPresetSchema } from '@/lib/presetSchemas'
import { requiredModelToComfyUIName } from '@/lib/comfyWorkflow'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const presetPath = path.resolve(__dirname, '../../../../modes/base/presets/pixel3d-trellis.json')
const modelConfigPath = path.resolve(__dirname, '../../../external/model_config.json')

const preset = ComfyUiPresetSchema.parse(JSON.parse(readFileSync(presetPath, 'utf-8')))
const modelPaths = JSON.parse(readFileSync(modelConfigPath, 'utf-8')) as Record<string, string>

describe('Pixel3D-Trellis preset', () => {
  it('applies the attention flag the shape sampler needs', () => {
    expect(preset.requiredComfyUiParameters).toEqual(['--use-quad-cross-attention'])
  })

  it('exposes only the final SaveGLB as an output node', () => {
    const outputs = Object.values(preset.comfyUiApiWorkflow).filter((node) =>
      ['SaveGLB', 'Save3DAdvanced', 'PreviewImage', 'Preview3DAdvanced', 'MaskPreview'].includes(
        node.class_type as string,
      ),
    )

    expect(outputs.map((node) => node.class_type as string)).toEqual(['SaveGLB'])
  })

  it('has a configured model directory for every required model type', () => {
    const missing = (preset.requiredModels ?? [])
      .map((model) => model.type)
      .filter((type) => !(type in modelPaths))

    expect(missing).toEqual([])
  })

  it('points every loader at the downloaded model path', () => {
    const loaderNames = new Set<string>(
      Object.values(preset.comfyUiApiWorkflow).flatMap((node) =>
        Object.entries(node.inputs ?? {})
          .filter(([name, value]) => name.endsWith('_name') && typeof value === 'string')
          .map(([, value]) => value as string),
      ),
    )

    for (const { model } of preset.requiredModels ?? []) {
      expect(loaderNames, model).toContain(requiredModelToComfyUIName(model))
    }
  })

  // Agent tools pick a variant named "Fast" when none is asked for, so this is
  // the model a game gets: small enough to embed in a page and load quickly.
  it('offers a game-ready Fast variant beside the full-quality default', () => {
    const defaultOf = (p: typeof preset, label: string) =>
      p.settings.find((setting) => setting.label === label)?.defaultValue

    const fast = applyVariant(preset, 'Fast') as typeof preset
    expect(defaultOf(fast, 'Texture Resolution')).toBe(1024)
    expect(defaultOf(fast, 'Target Face Count')).toBe(50000)
    expect(fast.comfyUiApiWorkflow['224'].inputs?.resolution).toBe(1024)

    const full = applyVariant(preset, 'Default') as typeof preset
    expect(defaultOf(full, 'Texture Resolution')).toBe(4096)
    expect(full.comfyUiApiWorkflow['224'].inputs?.resolution).toBe(2048)
  })
})
