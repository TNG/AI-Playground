import {
  FILES_CAPABILITY_ID,
  GAME_STUDIO_ID,
  GAME_STUDIO_QUICK_ID,
} from '@/types/agentCapabilities'

/** What an agent turn's model can be trusted with: tool calls at all, and long agent work. */
export type ModelToolUse = { toolCalling: boolean; agentic: boolean }

/** Capabilities denied to a model explicitly marked non-agentic; unknown still gets them, unverified. */
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

/** A catalog model's flags. Unknown agentic (`undefined`) is allowed, not granted. */
export function catalogModelToolUse(
  backend: string,
  model: ModelFlags | null | undefined,
): ModelToolUse {
  // A remote model is whatever the provider advertised plus whatever the user
  // overrode; an unset override must not read as "no".
  if (backend === 'cloud') {
    return {
      toolCalling: model?.supportsToolCalling !== false,
      agentic: model?.supportsAgentic !== false,
    }
  }
  return {
    toolCalling: model?.supportsToolCalling === true,
    // Unknown agentic is allowed (offered as unverified); explicit "no" gates.
    agentic: model?.supportsAgentic !== false,
  }
}

export function capabilityModelGateReason(
  id: string,
  use: ModelToolUse,
): ModelGateReason | undefined {
  if (!use.toolCalling) return 'AGENT_CAPABILITY_NO_TOOL_CALLING'
  if (use.agentic === false && HEAVY_CAPABILITY_IDS.includes(id))
    return 'AGENT_CAPABILITY_NOT_AGENTIC'
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
