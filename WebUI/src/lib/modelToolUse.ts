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

/** Why the model rules a capability out, as the i18n key the renderer shows. */
export type ModelGateReason = 'AGENT_CAPABILITY_NO_TOOL_CALLING' | 'AGENT_CAPABILITY_NOT_AGENTIC'

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

export function capabilityModelGateReason(
  id: string,
  use: ModelToolUse,
): ModelGateReason | undefined {
  if (!use.toolCalling) return 'AGENT_CAPABILITY_NO_TOOL_CALLING'
  if (!use.agentic && HEAVY_CAPABILITY_IDS.includes(id)) return 'AGENT_CAPABILITY_NOT_AGENTIC'
  return undefined
}

/** The checklist's catalog for this model: gated entries disabled with a reason. */
export function gateCapabilityCatalog<T extends { id: string; unavailableReason?: string }>(
  catalog: readonly T[],
  use: ModelToolUse,
  reasonText: (reason: ModelGateReason) => string,
): T[] {
  return catalog.map((capability) => {
    if (capability.unavailableReason) return capability
    const reason = capabilityModelGateReason(capability.id, use)
    return reason ? { ...capability, unavailableReason: reasonText(reason) } : capability
  })
}
