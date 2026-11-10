import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'

/** Shown names for presets whose identity stays the file name. */
const PRESET_DISPLAY_NAMES: Record<string, string> = { [HARNESS_CHAT_PRESET]: 'Agent Maker' }

/** The name to show. Sessions, files and settings still key on `presetName`. */
export function presetDisplayName(presetName: string): string {
  return PRESET_DISPLAY_NAMES[presetName] ?? presetName
}
