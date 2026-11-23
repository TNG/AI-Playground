import type { Preset } from '@/lib/presetSchemas'

// Param-resolution core shared by the renderer's panel run path
// (runArtifact.ts) and the main-process in-process Comfy funnel
// (inProcessComfy.ts). The value chain is always caller-specified →
// preset-declared default → last-resort fallback, so an agent/chat run of a
// preset matches what the panel would do with it.

/** Last-resort values when neither the caller nor the preset declares one. */
export const FALLBACK_PARAMS = {
  seed: -1,
  width: 512,
  height: 512,
  inferenceSteps: 6,
  batchSize: 1,
  negativePrompt: 'nsfw',
} as const

/** A preset's declared default for a generation param (e.g. 'inferenceSteps'). */
export function presetDefault(preset: Preset, settingName: string): unknown {
  return preset.settings.find((s) => 'settingName' in s && s.settingName === settingName)
    ?.defaultValue
}

/** The preset's declared default resolution as [width, height], when parseable. */
export function presetDefaultResolution(preset: Preset): [number, number] | [undefined, undefined] {
  const raw = presetDefault(preset, 'resolution')
  if (typeof raw !== 'string') return [undefined, undefined]
  const [width, height] = raw.split('x').map(Number)
  return [width, height]
}
