type PromptPreset = { systemPrompt?: string; agentOwnsPrompt?: boolean }

/** A preset that owns its prompt takes the user's own one; an empty one falls back to the preset's. */
export function harnessInstructions(
  preset: PromptPreset | null | undefined,
  userPrompt: string | undefined,
): string {
  const own = preset?.agentOwnsPrompt === true ? (userPrompt?.trim() ?? '') : ''
  return own || preset?.systemPrompt?.trim() || ''
}
