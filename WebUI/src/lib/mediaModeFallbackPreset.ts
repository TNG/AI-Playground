import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { listModeFor } from '@/lib/presetModes'
import type { Preset } from '@/lib/presetSchemas'

/** The preset to switch to when the active one sits under a Media Mode the user has turned off. */
export function mediaModeFallbackPreset(
  active: Preset | undefined,
  mediaModes: boolean,
): string | null {
  if (mediaModes || !active) return null
  return listModeFor(active) === 'chat' ? null : HARNESS_CHAT_PRESET
}
