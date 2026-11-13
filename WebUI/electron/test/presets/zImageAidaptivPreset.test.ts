import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ComfyUiPresetSchema } from '@/lib/presetSchemas'
import { modifySettingInWorkflow, workflowUsesSdCppImage } from '@/lib/comfyWorkflow'
import { getResolutionsFromConfig } from '@/lib/comfyResolutions'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const presetsDir = path.resolve(__dirname, '../../../../modes/base/presets')
const readPreset = (file: string) =>
  ComfyUiPresetSchema.parse(JSON.parse(readFileSync(path.join(presetsDir, file), 'utf-8')))
const aidaptiv = readPreset('z-image-aidaptiv.json')
const zImage = readPreset('z-image.json')
const nvidiaMode = JSON.parse(
  readFileSync(path.resolve(presetsDir, '../../nvidia/mode.json'), 'utf-8'),
) as { excludePresets?: string[] }

describe('Pro 2 Image (aiDAPTIV) preset', () => {
  it('is its own Image Gen preset, listed before Pro 2 Image', () => {
    expect(aidaptiv).toMatchObject({
      name: 'Pro 2 Image (aiDAPTIV)',
      category: 'create-images',
      requiresPhison: true,
      requiresService: 'sdcpp-backend',
    })
    expect(aidaptiv.tags).toContain('aiDAPTIV')
    expect(aidaptiv.displayPriority).toBeGreaterThan(zImage.displayPriority)
    expect(aidaptiv.variants).toBeUndefined()
    expect(existsSync(path.join(presetsDir, 'z-image-aidaptiv.png'))).toBe(true)
  })

  it('leaves Pro 2 Image with only its ComfyUI variant', () => {
    expect(zImage.variants?.map((v) => v.name)).toEqual(['Standard'])
    expect(workflowUsesSdCppImage(zImage.comfyUiApiWorkflow)).toBe(false)
  })

  it('runs the sd-server node, the safety check and the save', () => {
    const classes = Object.values(aidaptiv.comfyUiApiWorkflow)
      .map((node) => node.class_type as string)
      .sort()
    expect(classes).toEqual([
      'CM_FloatBinaryOperation',
      'PhisonSdServerImageGeneration',
      'SafetyChecker',
      'SaveImage',
    ])
    expect(workflowUsesSdCppImage(aidaptiv.comfyUiApiWorkflow)).toBe(true)
  })

  it('downloads the GGUF DiT, Qwen3-4B, the VAE and the NSFW detector, and no GGUF loader node', () => {
    expect(aidaptiv.requiredModels?.map((m) => `${m.type}:${m.model}`)).toEqual([
      'unet:jayn7/Z-Image-Turbo-GGUF/z_image_turbo-Q4_K_M.gguf',
      'clip:Comfy-Org/z_image_turbo/split_files/text_encoders/qwen_3_4b.safetensors',
      'vae:Comfy-Org/z_image_turbo/split_files/vae/ae.safetensors',
      'nsfwdetector:AdamCodd/vit-base-nsfw-detector/config.json',
      'nsfwdetector:AdamCodd/vit-base-nsfw-detector/model.safetensors',
      'nsfwdetector:AdamCodd/vit-base-nsfw-detector/preprocessor_config.json',
    ])
    expect(aidaptiv.requiredCustomNodes?.some((n) => n.includes('ComfyUI-GGUF'))).toBe(false)
  })

  it('drops the settings the sd-server node cannot use', () => {
    const labels = aidaptiv.settings.map((s) => s.label)
    expect(labels).not.toContain('Negative Prompt')
    expect(labels).not.toContain('Show Preview')
  })

  it('routes the prompt, seed, steps and size settings to the sd-server node', () => {
    const workflow = structuredClone(aidaptiv.comfyUiApiWorkflow)
    modifySettingInWorkflow(workflow, 'prompt', 'a lion')
    modifySettingInWorkflow(workflow, 'seed', '42')
    modifySettingInWorkflow(workflow, 'inferenceSteps', 9)
    modifySettingInWorkflow(workflow, 'width', 1344)
    modifySettingInWorkflow(workflow, 'height', 768)
    expect(workflow['1']!.inputs).toMatchObject({
      text: 'a lion',
      seed: '42',
      steps: 9,
      width: 1344,
      height: 768,
    })
  })

  it('only offers sizes sd-server accepts (multiples of 16)', () => {
    const sizes = getResolutionsFromConfig(aidaptiv.resolutionConfig!)
    expect(sizes.length).toBeGreaterThan(0)
    expect(sizes.filter((s) => s.width % 16 !== 0 || s.height % 16 !== 0)).toEqual([])
  })

  it('is hidden in NVIDIA mode, which has no SYCL add-on', () => {
    expect(nvidiaMode.excludePresets).toContain('z-image-aidaptiv')
  })
})
