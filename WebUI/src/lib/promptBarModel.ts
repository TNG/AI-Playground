import type { Preset } from '@/lib/presetSchemas'
import { MODE_TO_CATEGORIES, listModeFor, presetToMode } from '@/lib/presetModes'
import { HARNESS_CHAT_PRESET, isHarnessChatPreset } from '@/lib/harnessChatPreset'
import { hasChatAffordances } from '@/lib/chatAffordances'
import type { PresetGate, PresetGateReason } from '@/lib/presetGate'
import type { PromptBarStyle } from '@/assets/js/store/promptBarStyle'
import type { llmBackendTypes } from '@/types/shared'

type LlmBackend = (typeof llmBackendTypes)[number]

export type SpeechBackend = 'openVINO' | 'qwen3TTS' | 'external'

export type DeviceCategory = 'gpu' | 'npu' | 'cpu'

export type DeviceChip = {
  kind: 'device'
  name: string
  label: string
  category: DeviceCategory
  categoryLabel: string
}

export type HeaderChip =
  | { kind: 'backend'; backend: LlmBackend | SpeechBackend | 'comfyui' }
  | DeviceChip
  | { kind: 'model'; name: string; id: string; source: 'chat' | 'comfy' }
  | { kind: 'preset'; name: string; label: string; image?: string; agentId?: string }

export type PromptBarMachine = {
  chatBackend: LlmBackend
  chatModel?: string
  speechBackend?: SpeechBackend
  /** Selected device of the service running the active preset. */
  device?: InferenceDevice
}

type LastUsed = Partial<Record<ModeType, (string | null | undefined)[]>>

export type PromptBarInput = {
  /** With its variant applied. */
  activePreset: Preset | null
  presetLabel: (name: string) => string
  machine: PromptBarMachine
  catalog?: Preset[]
  /** Most specific first. */
  lastUsed?: LastUsed
  presetGate?: (preset: Preset) => PresetGate
  style?: PromptBarStyle
  /** The Agent Library, each Agent with its saved name, description and image. */
  agents?: readonly PromptBarAgent[]
  /** The open Session's picked Agent. */
  pickedAgentId?: string
  /** False offers the Assistant Mode alone. Defaults to true. */
  mediaModes?: boolean
}

export type PromptBarAgent = AgentEntry & {
  /** False while the Agent exists only as a Draft. */
  saved: boolean
}

export type AgentEntry = { id: string; name: string; description?: string; image?: string }

export type PromptBarModel = {
  headerChips: HeaderChip[]
  modes: ModeType[]
  activeMode: ModeType | null
  modePicks: Partial<Record<ModeType, string>>
  /** What each offered Mode lists, whichever Mode is active. */
  listings: Partial<Record<ModeType, ModeListing>>
  /** The Agent run on Assistant in place of Assistant itself. */
  pickedAgent?: AgentEntry
  presetChip: 'label' | 'dropdown'
  /** The mic and camera buttons. */
  capture: boolean
}

export type ModeListing = {
  /** In order, empty groups left out. */
  groups: PresetGroup[]
  /** Whether the list ends with "Manage Agents…". */
  manageAgents: boolean
}

export type PresetGroupKind = 'main' | 'agent' | 'saved'

/**
 * `main`: in the Assistant Mode, the Assistant preset first.
 * `agent`: the agent presets, under the Agent heading.
 * `saved`: the saved Agents, set apart by a separator.
 */
export type PresetGroup = { kind: PresetGroupKind; presets: PresetEntry[]; agents: AgentEntry[] }

export type PresetEntry = {
  name: string
  label: string
  image?: string
  description?: string
  enabled: boolean
  reason?: PresetGateReason
}

export function promptBarModel(input: PromptBarInput): PromptBarModel {
  const catalog = input.catalog ?? []
  const gateOf = (preset: Preset) => input.presetGate?.(preset) ?? { enabled: true }
  const modes = promptBarModes(catalog).filter(
    (mode) => input.mediaModes !== false || mode === ASSISTANT_MODE,
  )
  const modePicks: Partial<Record<ModeType, string>> = {}
  for (const mode of modes) {
    const enabled = presetsInMode(catalog, mode).filter((preset) => gateOf(preset).enabled)
    const pick = presetForModePick(enabled, mode, input.lastUsed?.[mode] ?? [])
    if (pick) modePicks[mode] = pick
  }
  const pickable = pickableAgents(input.agents ?? [])
  const pickedAgent = isHarnessChatPreset(input.activePreset?.name)
    ? pickable.find((agent) => agent.id === input.pickedAgentId)
    : undefined
  const activeMode = input.activePreset ? listModeFor(input.activePreset) : null
  const entry = (preset: Preset): PresetEntry => {
    const gate = gateOf(preset)
    return {
      name: preset.name,
      label: input.presetLabel(preset.name),
      image: preset.image,
      ...(preset.description === undefined ? {} : { description: preset.description }),
      enabled: gate.enabled,
      ...(gate.reason === undefined ? {} : { reason: gate.reason }),
    }
  }
  const listings = Object.fromEntries(
    modes.map((mode) => [mode, modeListing(presetsInMode(catalog, mode), mode, pickable, entry)]),
  )
  const active = activeMode ? listings[activeMode] : undefined
  const entries = (active?.groups ?? []).reduce(
    (count, group) => count + group.presets.length + group.agents.length,
    0,
  )
  const dropdown = entries > 1 || !!active?.manageAgents
  return {
    headerChips: headerChips(input, pickedAgent),
    modes,
    activeMode,
    modePicks,
    listings,
    ...(pickedAgent ? { pickedAgent } : {}),
    presetChip: input.style !== 'classic' && dropdown ? 'dropdown' : 'label',
    capture: hasChatAffordances(input.activePreset),
  }
}

function modeListing(
  listed: Preset[],
  mode: ModeType,
  agents: AgentEntry[],
  entry: (preset: Preset) => PresetEntry,
): ModeListing {
  if (mode !== ASSISTANT_MODE) {
    return {
      groups: nonEmpty([{ kind: 'main', presets: listed.map(entry), agents: [] }]),
      manageAgents: false,
    }
  }
  const isAgentPreset = (preset: Preset) => presetToMode(preset) === 'agent'
  const main = listed.filter((preset) => !isAgentPreset(preset) || isHarnessChatPreset(preset.name))
  const agentPresets = listed.filter((preset) => !main.includes(preset))
  const ordered = [
    ...main.filter((preset) => isHarnessChatPreset(preset.name)),
    ...main.filter((preset) => !isHarnessChatPreset(preset.name)),
  ]
  return {
    groups: nonEmpty([
      { kind: 'main', presets: ordered.map(entry), agents: [] },
      { kind: 'agent', presets: agentPresets.map(entry), agents: [] },
      { kind: 'saved', presets: [], agents },
    ]),
    manageAgents: true,
  }
}

function nonEmpty(groups: PresetGroup[]): PresetGroup[] {
  return groups.filter((group) => group.presets.length + group.agents.length > 0)
}

/** The Agents a prompt bar offers: saved ones only, a Draft-only Agent cannot run yet. */
export function pickableAgents(agents: readonly PromptBarAgent[]): AgentEntry[] {
  return agents
    .filter((agent) => agent.saved)
    .map(({ id, name, description, image }) => ({
      id,
      name,
      ...(description === undefined ? {} : { description }),
      ...(image === undefined ? {} : { image }),
    }))
}

const ASSISTANT_MODE: ModeType = 'chat'

const MODES: ModeType[] = [ASSISTANT_MODE, 'audio', 'imageGen', 'imageEdit', 'video']

/** The Modes a prompt bar offers, in order. */
export function promptBarModes(catalog: Preset[]): ModeType[] {
  return MODES.filter((mode) => presetsInMode(catalog, mode).length > 0)
}

export function presetsInMode(catalog: Preset[], mode: ModeType): Preset[] {
  return catalog.filter((preset) => listModeFor(preset) === mode)
}

export function lastUsedByMode(
  perMode: Partial<Record<ModeType, string>>,
  perCategory: Record<string, string | null | undefined>,
): LastUsed {
  return Object.fromEntries(
    (Object.keys(MODE_TO_CATEGORIES) as ModeType[]).map((mode) => [
      mode,
      // The category is written by every preset listed under the Mode, so it is the most recent.
      [...MODE_TO_CATEGORIES[mode].map((category) => perCategory[category]), perMode[mode]],
    ]),
  )
}

function presetForModePick(
  listed: Preset[],
  mode: ModeType,
  lastUsed: (string | null | undefined)[],
): string | undefined {
  const remembered = lastUsed.find((name) => name && listed.some((p) => p.name === name))
  const preferred = MODE_DEFAULT_PRESET[mode]
  const fallback = listed.find((p) => p.name === preferred) ?? listed[0]
  return remembered ?? fallback?.name
}

const MODE_DEFAULT_PRESET: Partial<Record<ModeType, string>> = {
  [ASSISTANT_MODE]: HARNESS_CHAT_PRESET,
}

function headerChips(
  { activePreset: preset, presetLabel, machine }: PromptBarInput,
  pickedAgent: AgentEntry | undefined,
): HeaderChip[] {
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
    const speech = machine.speechBackend
    chips.push(
      speech ? { kind: 'backend', backend: speech } : undefined,
      speech === 'external' ? undefined : device,
    )
  } else {
    chips.push(
      { kind: 'backend', backend: machine.chatBackend },
      machine.chatBackend === 'cloud' ? undefined : device,
      machine.chatModel ? modelChip(machine.chatModel, 'chat') : undefined,
    )
  }
  chips.push(
    pickedAgent
      ? {
          kind: 'preset',
          name: preset.name,
          label: pickedAgent.name,
          image: pickedAgent.image,
          agentId: pickedAgent.id,
        }
      : { kind: 'preset', name: preset.name, label: presetLabel(preset.name), image: preset.image },
  )
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
