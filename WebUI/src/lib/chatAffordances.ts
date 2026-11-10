import type { Preset } from '@/lib/presetSchemas'
import { presetToMode } from '@/lib/presetModes'
import { currentPresetName } from '@/lib/presetRenames'
import { isHarnessChatPreset } from '@/lib/harnessChatPreset'

/**
 * Whether a preset gets the chat UI (mic, camera, audio clips, Speak, speak-replies): every
 * plain chat preset, plus the harness chat preset. The games presets keep the agent UI.
 */
export function hasChatAffordances(preset: Preset | null | undefined): boolean {
  if (preset?.type !== 'chat') return false
  return presetToMode(preset) === 'chat' || isHarnessChatPreset(currentPresetName(preset.name))
}

/** The same question for a turn the agent harness ran, which knows only its preset's name. */
export function agentTurnHasChatAffordances(presetName: string | undefined): boolean {
  return isHarnessChatPreset(currentPresetName(presetName ?? ''))
}
