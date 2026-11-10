import type { Preset } from '@/lib/presetSchemas'
import { MODE_TO_CATEGORIES, presetToMode } from '@/lib/presetModes'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
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
  /** In the agent mode, the Agent Presets. */
  presets: PresetEntry[]
  /** In the agent mode, the saved Agents listed after the Agent Presets. */
  agents: AgentEntry[]
  /** The Agent run on Agent Maker in place of Agent Maker itself. */
  pickedAgent?: AgentEntry
  presetChip: 'label' | 'dropdown'
}

export type PresetEntry = {
  name: string
  label: string
  image?: string
  enabled: boolean
  reason?: PresetGateReason
}

export function promptBarModel(input: PromptBarInput): PromptBarModel {
  const catalog = input.catalog ?? []
  const gateOf = (preset: Preset) => input.presetGate?.(preset) ?? { enabled: true }
  const modes = MODERN_MODES.filter((mode) => presetsInMode(catalog, mode).length > 0)
  const modePicks: Partial<Record<ModeType, string>> = {}
  for (const mode of modes) {
    const enabled = presetsInMode(catalog, mode).filter((preset) => gateOf(preset).enabled)
    const pick = presetForModePick(enabled, mode, input.lastUsed?.[mode] ?? [])
    if (pick) modePicks[mode] = pick
  }
  const activeMode = input.activePreset ? presetToMode(input.activePreset) : null
  const presets = activeMode
    ? presetsInMode(catalog, activeMode).map((preset) => {
        const gate = gateOf(preset)
        return {
          name: preset.name,
          label: input.presetLabel(preset.name),
          image: preset.image,
          enabled: gate.enabled,
          reason: gate.reason,
        }
      })
    : []
  const presetChip = input.style !== 'classic' && presets.length > 1 ? 'dropdown' : 'label'
  const agents = activeMode === 'agent' ? pickableAgents(input.agents ?? []) : []
  const pickedAgent =
    input.activePreset?.name === MODE_DEFAULT_PRESET.agent
      ? agents.find((agent) => agent.id === input.pickedAgentId)
      : undefined
  return {
    headerChips: headerChips(input, pickedAgent),
    modes,
    activeMode,
    modePicks,
    presets,
    agents,
    ...(pickedAgent ? { pickedAgent } : {}),
    presetChip,
  }
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

const AGENT_FILTER_THRESHOLD = 8

export type AgentList = {
  /** Whether the list is long enough to carry a filter field. */
  filterable: boolean
  agents: AgentEntry[]
}

/** The Agents a prompt bar lists, narrowed by the filter field once there are enough of them. */
export function agentList(agents: readonly AgentEntry[], query: string): AgentList {
  const filterable = agents.length > AGENT_FILTER_THRESHOLD
  const needle = query.trim().toLocaleLowerCase()
  if (!filterable || !needle) return { filterable, agents: [...agents] }
  const matches = (text?: string) => !!text?.toLocaleLowerCase().includes(needle)
  return {
    filterable,
    agents: agents.filter((agent) => matches(agent.name) || matches(agent.description)),
  }
}

const MODERN_MODES: ModeType[] = ['chat', 'agent', 'audio', 'imageGen', 'imageEdit', 'video']

export function presetsInMode(catalog: Preset[], mode: ModeType): Preset[] {
  return catalog.filter((preset) => presetToMode(preset) === mode)
}

export function lastUsedByMode(
  perMode: Partial<Record<ModeType, string>>,
  perCategory: Record<string, string | null | undefined>,
): LastUsed {
  return Object.fromEntries(
    (Object.keys(MODE_TO_CATEGORIES) as ModeType[]).map((mode) => [
      mode,
      [perMode[mode], ...MODE_TO_CATEGORIES[mode].map((category) => perCategory[category])],
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

const MODE_DEFAULT_PRESET: Partial<Record<ModeType, string>> = { agent: HARNESS_CHAT_PRESET }

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
