import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { currentPresetName } from '@/lib/presetRenames'
import type { SessionLastPreset } from '@/types/sessionIpc'

/**
 * The preset opening a Session switches to: its last turn's (under its current name), or
 * Assistant for a picked Agent whose last turn ran under a preset that is gone (an Agent
 * Preset folded into its Agent).
 */
export function sessionReopenPreset(
  last: SessionLastPreset | null,
  knownPresets: readonly string[],
  pickedAgentId: string | undefined,
): SessionLastPreset | null {
  if (!last) return null
  const renamed = { ...last, preset: currentPresetName(last.preset) }
  if (knownPresets.includes(renamed.preset)) return renamed
  return pickedAgentId && knownPresets.includes(HARNESS_CHAT_PRESET)
    ? { preset: HARNESS_CHAT_PRESET }
    : null
}
