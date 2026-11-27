import type { ChatPreset, Preset } from '@/lib/presetSchemas'

export type PresetGateReason = 'PRESET_GATE_PHISON'

/** `reason` is an i18n key. */
export type PresetGate = { enabled: boolean; reason?: PresetGateReason }

export type PresetGateFacts = {
  phisonUsable: boolean
}

// Presets this system can never run are filtered out upstream; these can still be turned on.
export function presetGate(preset: Preset, facts: PresetGateFacts): PresetGate {
  if (preset.type === 'chat' && (preset as ChatPreset).requiresPhison) {
    return facts.phisonUsable ? { enabled: true } : { enabled: false, reason: 'PRESET_GATE_PHISON' }
  }
  return { enabled: true }
}
