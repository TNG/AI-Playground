import type { ChatPreset, Preset } from '@/lib/presetSchemas'
import { HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'

export type PresetGateReason =
  'PRESET_GATE_PHISON' | 'PRESET_GATE_HOME_AGENT_DISABLED' | 'PRESET_GATE_HOME_AGENT_UNAVAILABLE'

/** `reason` is an i18n key. */
export type PresetGate = { enabled: boolean; reason?: PresetGateReason }

export type PresetGateFacts = {
  phisonUsable: boolean
  homeAgentEnabled: boolean
  homeAgentAvailable: boolean
}

// Presets this system can never run are filtered out upstream; these can still be turned on.
export function presetGate(preset: Preset, facts: PresetGateFacts): PresetGate {
  if (preset.type === 'chat' && (preset as ChatPreset).requiresPhison) {
    return facts.phisonUsable ? { enabled: true } : { enabled: false, reason: 'PRESET_GATE_PHISON' }
  }
  if (preset.name === HOME_AGENT_CHAT_PRESET_NAME) {
    if (!facts.homeAgentEnabled) {
      return { enabled: false, reason: 'PRESET_GATE_HOME_AGENT_DISABLED' }
    }
    if (!facts.homeAgentAvailable) {
      return { enabled: false, reason: 'PRESET_GATE_HOME_AGENT_UNAVAILABLE' }
    }
    return { enabled: true }
  }
  return { enabled: true }
}
