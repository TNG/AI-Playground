/**
 * The general harness chat preset: the chat preset Agent Runs use and per-Session settings
 * bind to. The games presets are not it. Named rather than looked up, because session
 * migration runs on hydration, before the preset catalog is loaded.
 */
export const HARNESS_CHAT_PRESET = 'Assistant'

export function isHarnessChatPreset(name: string | null | undefined): boolean {
  return name === HARNESS_CHAT_PRESET
}
