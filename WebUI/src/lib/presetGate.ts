import type { ChatPreset, Preset } from '@/assets/js/store/presets'
import { HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'

export type PresetGate = { enabled: boolean; reason?: string }

export type PresetGateFacts = {
  phisonUsable: boolean
  homeAgentEnabled: boolean
  homeAgentAvailable: boolean
}

/**
 * Whether a preset in a picker can be selected now. Presets gated on a feature the user can
 * still turn on stay listed but disabled with a reason; ones this system can never run are
 * filtered out upstream.
 */
export function presetGate(preset: Preset, facts: PresetGateFacts): PresetGate {
  if (preset.type === 'chat' && (preset as ChatPreset).requiresPhison) {
    return facts.phisonUsable
      ? { enabled: true }
      : { enabled: false, reason: 'Install and activate the aiDAPTIV™ build to use this preset.' }
  }
  if (preset.name === HOME_AGENT_CHAT_PRESET_NAME) {
    if (!facts.homeAgentEnabled) {
      return { enabled: false, reason: 'Enable the Home Agent in settings to use this preset.' }
    }
    if (!facts.homeAgentAvailable) {
      return { enabled: false, reason: 'The Home Agent backend is not installed or running yet.' }
    }
    return { enabled: true }
  }
  return { enabled: true }
}
