import type { Preset } from '@/lib/presetSchemas'
import { hasChatAffordances } from '@/lib/chatAffordances'
import { FILES_CAPABILITY_ID } from '@/types/agentCapabilities'

/** The preset-dependent parts of the agent settings tabs; the model decides the rest. */
export type AgentSettingsSections = {
  /** Max tokens, temperature, reasoning effort, MTP draft tokens and the metrics toggle. */
  sampling: boolean
  systemPrompt: boolean
  speakReplies: boolean
  /** Only a preset that owns its prompt goes without the file and shell tools. */
  filesCapability: boolean
}

export function agentSettingsSections(preset: Preset | null | undefined): AgentSettingsSections {
  const chat = hasChatAffordances(preset)
  const ownsPrompt = preset?.type === 'chat' && preset.agentOwnsPrompt === true
  return {
    sampling: chat,
    systemPrompt: chat && ownsPrompt,
    speakReplies: chat,
    filesCapability: ownsPrompt,
  }
}

/** The capabilities the checklist offers: what the session can switch on for this preset. */
export function checklistCapabilities<T extends { id: string }>(
  catalog: readonly T[],
  sections: AgentSettingsSections,
): T[] {
  return catalog.filter(
    (capability) => sections.filesCapability || capability.id !== FILES_CAPABILITY_ID,
  )
}
