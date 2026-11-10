import {
  FILES_CAPABILITY_ID,
  GAME_STUDIO_ID,
  GAME_STUDIO_QUICK_ID,
} from '@/types/agentCapabilities'

/** What an agent turn's model can be trusted with: tool calls at all, and long agent work. */
export type ModelToolUse = { toolCalling: boolean; agentic: boolean }

/** Capabilities only a model marked `supportsAgentic` gets: long file, shell and game work. */
export const HEAVY_CAPABILITY_IDS: readonly string[] = [
  FILES_CAPABILITY_ID,
  GAME_STUDIO_ID,
  GAME_STUDIO_QUICK_ID,
]

export const NO_TOOL_CALLING_REASON = 'This model cannot call tools.'
export const NOT_AGENTIC_REASON = 'Needs a model suited to agent work.'

type ModelFlags = { supportsToolCalling?: boolean; supportsAgentic?: boolean }

/** A turn config's flags; an unset one (cloud, older callers) does not restrict. */
export function turnModelToolUse(model: ModelFlags): ModelToolUse {
  return {
    toolCalling: model.supportsToolCalling !== false,
    agentic: model.supportsAgentic !== false,
  }
}

/** A catalog model's flags, where unset means unknown and so not granted; cloud carries none. */
export function catalogModelToolUse(
  backend: string,
  model: ModelFlags | null | undefined,
): ModelToolUse {
  if (backend === 'cloud') return { toolCalling: true, agentic: true }
  return {
    toolCalling: model?.supportsToolCalling === true,
    agentic: model?.supportsAgentic === true,
  }
}

/** Why the model rules a capability out, or undefined when it may run. */
export function capabilityModelGateReason(id: string, use: ModelToolUse): string | undefined {
  if (!use.toolCalling) return NO_TOOL_CALLING_REASON
  if (!use.agentic && HEAVY_CAPABILITY_IDS.includes(id)) return NOT_AGENTIC_REASON
  return undefined
}

/** The capability catalog as the settings checklist shows it for this model: gated entries disabled with a reason. */
export function gateCapabilityCatalog<T extends { id: string; unavailableReason?: string }>(
  catalog: readonly T[],
  use: ModelToolUse,
): T[] {
  return catalog.map((capability) => {
    if (capability.unavailableReason) return capability
    const reason = capabilityModelGateReason(capability.id, use)
    return reason ? { ...capability, unavailableReason: reason } : capability
  })
}
