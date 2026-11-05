import { AUDIO_CATEGORY, type Preset } from '@/lib/presetSchemas'
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
  /** The presets the pickers list, after product-mode and system filtering. */
  catalog?: Preset[]
  /** Remembered preset names per mode, most specific first. */
  lastUsed?: Partial<Record<ModeType, (string | null | undefined)[]>>
}

export type PromptBarModel = {
  headerChips: HeaderChip[]
  /** The Modern Mode dropdown's entries, in order, without modes that have no presets. */
  modes: ModeType[]
  activeMode: ModeType | null
  /** The preset picking each offered mode activates. */
  modePicks: Partial<Record<ModeType, string>>
}

export function promptBarModel(input: PromptBarInput): PromptBarModel {
  const catalog = input.catalog ?? []
  const modes = MODERN_MODES.filter((mode) => presetsInMode(catalog, mode).length > 0)
  const modePicks: Partial<Record<ModeType, string>> = {}
  for (const mode of modes) {
    modePicks[mode] = presetForModePick(catalog, mode, input.lastUsed?.[mode] ?? [])
  }
  return {
    headerChips: headerChips(input),
    modes,
    activeMode: input.activePreset ? modernModeOf(input.activePreset) : null,
    modePicks,
  }
}

const MODERN_MODES: ModeType[] = ['chat', 'agent', 'audio', 'imageGen', 'imageEdit', 'video']

/** The Modern prompt bar's grouping: Agent Presets get a mode of their own instead of riding Chat. */
export function modernModeOf(preset: Preset): ModeType {
  if (preset.type === 'chat') {
    if (preset.agentPreset) return 'agent'
    return preset.category === AUDIO_CATEGORY ? 'audio' : 'chat'
  }
  switch (preset.category) {
    case 'edit-images':
      return 'imageEdit'
    case 'create-videos':
      return 'video'
    default:
      return 'imageGen'
  }
}

export function presetsInMode(catalog: Preset[], mode: ModeType): Preset[] {
  return catalog.filter((preset) => modernModeOf(preset) === mode)
}

function presetForModePick(
  catalog: Preset[],
  mode: ModeType,
  lastUsed: (string | null | undefined)[],
): string {
  const listed = presetsInMode(catalog, mode)
  const remembered = lastUsed.find((name) => name && listed.some((p) => p.name === name))
  return remembered ?? listed[0].name
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
