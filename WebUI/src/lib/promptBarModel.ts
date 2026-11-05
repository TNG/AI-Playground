import type { Preset } from '@/lib/presetSchemas'
import type { llmBackendTypes } from '@/types/shared'

type LlmBackend = (typeof llmBackendTypes)[number]

export type DeviceCategory = 'gpu' | 'npu' | 'cpu'

export type DeviceChip = {
  kind: 'device'
  name: string
  label: string
  category: DeviceCategory
  categoryLabel: string
}

export type HeaderChip =
  | { kind: 'backend'; backend: LlmBackend | 'comfyui' }
  | DeviceChip
  | { kind: 'model'; name: string; id: string; source: 'chat' | 'comfy' }
  | { kind: 'preset'; name: string; label: string; image?: string }

export type PromptBarMachine = {
  chatBackend: LlmBackend
  chatModel?: string
  /** The selected device of the service that runs the active preset. */
  device?: InferenceDevice
}

export type PromptBarInput = {
  /** The active preset with its variant applied. */
  activePreset: Preset | null
  presetLabel: (name: string) => string
  machine: PromptBarMachine
}

export type PromptBarModel = {
  headerChips: HeaderChip[]
}

export function promptBarModel(input: PromptBarInput): PromptBarModel {
  return { headerChips: headerChips(input) }
}

function headerChips({ activePreset: preset, presetLabel, machine }: PromptBarInput): HeaderChip[] {
  if (!preset) return []
  const device = machine.device ? classifyInferenceDevice(machine.device) : undefined
  const chips: (HeaderChip | undefined)[] = []
  if (preset.type === 'comfy') {
    const checkpoint = comfyCheckpoint(preset)
    chips.push(
      { kind: 'backend', backend: 'comfyui' },
      device,
      checkpoint ? modelChip(checkpoint, 'comfy') : undefined,
    )
  } else if (preset.ttsPreset || preset.sttPreset) {
    chips.push(device)
  } else {
    chips.push(
      { kind: 'backend', backend: machine.chatBackend },
      machine.chatBackend === 'cloud' ? undefined : device,
      machine.chatModel ? modelChip(machine.chatModel, 'chat') : undefined,
    )
  }
  chips.push({
    kind: 'preset',
    name: preset.name,
    label: presetLabel(preset.name),
    image: preset.image,
  })
  return chips.filter((chip) => !!chip)
}

function modelChip(id: string, source: 'chat' | 'comfy'): HeaderChip {
  const name = (id.split('/').at(-1) ?? id).replace(/\.(gguf|bin|safetensors)$/i, '')
  return { kind: 'model', name, id, source }
}

// The diffusion model is a unet / diffusion_models entry in split workflows, a checkpoint otherwise.
const CHECKPOINT_TYPES = [['unet', 'diffusion_models'], ['checkpoints']]

function comfyCheckpoint(preset: Preset): string | undefined {
  for (const types of CHECKPOINT_TYPES) {
    const models = (preset.requiredModels ?? []).filter((m) => types.includes(m.type))
    if (models.length > 0) return models.length === 1 ? models[0].model : undefined
  }
  return undefined
}

// OpenVINO ids like 'NPU' / 'CPU' / 'GPU.0', llama.cpp and ComfyUI numeric ids with GPU names,
// torch strings ('xpu:N' / 'cpu') for TTS: anything not NPU/CPU counts as GPU.
export function classifyInferenceDevice(device: InferenceDevice): DeviceChip {
  const haystack = `${device.id} ${device.name}`.toUpperCase()
  const category: DeviceCategory = haystack.includes('NPU')
    ? 'npu'
    : device.id.toUpperCase() === 'CPU' || /\bCPU\b/.test(haystack)
      ? 'cpu'
      : 'gpu'
  const categoryLabel = category === 'npu' ? 'NPU' : category === 'cpu' ? 'CPU' : 'GPU'
  const name = device.name || device.id
  const short = name
    .replace(/\((R|TM)\)/gi, '')
    .replace(/^\s*Intel\b/i, '')
    .replace(/\bGraphics\s*$/i, '')
    .trim()
  const label = new RegExp(`\\b${categoryLabel}\\b`, 'i').test(short)
    ? short
    : `${short} ${categoryLabel}`
  return { kind: 'device', name, label, category, categoryLabel }
}
