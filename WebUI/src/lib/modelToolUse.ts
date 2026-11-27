import {
  FILES_CAPABILITY_ID,
  GAME_STUDIO_ID,
  GAME_STUDIO_QUICK_ID,
  MCP_CAPABILITY_PREFIX,
  NOTIFY_CAPABILITY_ID,
  OVERVIEW_CAPABILITY_ID,
  WEB_CAPABILITY_ID,
  WEB_SCREENSHOT_CAPABILITY_ID,
} from '@/types/agentCapabilities'
import { fillTemplate } from './fillTemplate'

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

/**
 * A catalog model's flags. A local backend grants nothing but an explicit true;
 * cloud keeps its assume-capable default, so only a flag the provider advertised
 * or the user set in Edit Capabilities restricts the model.
 */
export function catalogModelToolUse(
  backend: string,
  model: ModelFlags | null | undefined,
): ModelToolUse {
  if (backend === 'cloud') {
    return {
      toolCalling: model?.supportsToolCalling !== false,
      agentic: model?.supportsAgentic !== false,
    }
  }
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

/**
 * Capabilities whose value is tools in the session build (each declares
 * `buildTools`), plus `files`, which keeps the core file and shell builtins
 * for a preset that owns its prompt. Memory contributes skills and hooks
 * only, so a session with nothing but memory runs toolless.
 */
const TOOL_CAPABILITY_IDS = new Set([
  FILES_CAPABILITY_ID,
  'media',
  'rag',
  WEB_CAPABILITY_ID,
  WEB_SCREENSHOT_CAPABILITY_ID,
  'web-debug',
  NOTIFY_CAPABILITY_ID,
  OVERVIEW_CAPABILITY_ID,
  GAME_STUDIO_ID,
  GAME_STUDIO_QUICK_ID,
])

/**
 * Whether a session as configured would hand the model any tool: a preset
 * that does not own its prompt always keeps the core file and shell builtins,
 * and any tool-carrying capability (or attached MCP server) counts.
 */
export function agentSessionNeedsTools(
  capabilities: readonly string[],
  presetOwnsPrompt: boolean,
): boolean {
  if (!presetOwnsPrompt) return true
  return capabilities.some(
    (id) => id.startsWith(MCP_CAPABILITY_PREFIX) || TOOL_CAPABILITY_IDS.has(id),
  )
}

/** What a run-start check refuses the turn over; null means the model passes. */
export type AgentRunModelGap = 'toolCalling' | 'agentic'

/**
 * The run-start gate for every Agent Mode turn. Tool calling is only relevant
 * when the session would actually have tools; the agentic gate is unconditional
 * — an Agent Mode run is multi-step tool use by definition.
 */
export function agentRunModelGap(input: {
  backend: string
  activeLlmModel: ModelFlags | null | undefined
  capabilities: readonly string[]
  presetOwnsPrompt: boolean
}): AgentRunModelGap | null {
  const use = catalogModelToolUse(input.backend, input.activeLlmModel)
  if (use.toolCalling && use.agentic) return null
  if (!use.toolCalling) {
    return agentSessionNeedsTools(input.capabilities, input.presetOwnsPrompt) ? 'toolCalling' : null
  }
  return 'agentic'
}

/** The refusal message for a run the gate blocks, in the active locale. */
export function agentRunModelGapMessage(
  gap: AgentRunModelGap,
  model: string,
  labels: Record<string, string | undefined>,
): string {
  const key =
    gap === 'toolCalling' ? 'AGENT_RUN_MODEL_NOT_TOOL_CALLING' : 'AGENT_RUN_MODEL_NOT_AGENTIC'
  const fallback =
    gap === 'toolCalling'
      ? 'Not started: {model} cannot call tools, so this session’s tools would be unusable. ' +
        'Switch to a model with tool-calling support in the session’s model settings.'
      : 'Not started: {model} is not agentic (not reliable at multi-step tool use). ' +
        'Switch to an agentic-capable model in the session’s model settings.'
  return fillTemplate(labels[key] ?? fallback, { model })
}

/** The gate's refusal as the Session's answer: the same sentence, without the "Not started:" lead. */
export function agentRunModelGapAnswer(
  gap: AgentRunModelGap,
  model: string,
  labels: Record<string, string | undefined>,
): string {
  const key =
    gap === 'toolCalling'
      ? 'AGENT_RUN_MODEL_NOT_TOOL_CALLING_ANSWER'
      : 'AGENT_RUN_MODEL_NOT_AGENTIC_ANSWER'
  const fallback =
    gap === 'toolCalling'
      ? '{model} cannot call tools, so this session’s tools would be unusable. ' +
        'Switch to a model with tool-calling support in the session’s model settings.'
      : '{model} is not agentic (not reliable at multi-step tool use). ' +
        'Switch to an agentic-capable model in the session’s model settings.'
  return fillTemplate(labels[key] ?? fallback, { model })
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
