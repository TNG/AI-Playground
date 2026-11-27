/** Named rather than looked up: session migration runs before the preset catalog loads. */
export const HARNESS_CHAT_PRESET = 'Assistant'

export function isHarnessChatPreset(name: string | null | undefined): boolean {
  return name === HARNESS_CHAT_PRESET
}
