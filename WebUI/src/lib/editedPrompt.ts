type PartWithText = { type: string; text?: string }

export type EditablePromptMessage = { parts: PartWithText[] }

/**
 * The first text part carries the edited text and the other text parts drop out; files stay put.
 * Null when the edit would change nothing.
 */
export function editedPromptParts(
  message: EditablePromptMessage,
  edited: string,
): PartWithText[] | null {
  const parts = message.parts
  if (!parts || parts.length === 0) return null
  const firstText = parts.findIndex((part) => part.type === 'text')
  if (firstText < 0) return null
  const unchanged =
    parts.filter((part) => part.type === 'text').length === 1 && parts[firstText].text === edited
  if (unchanged) return null
  return parts.flatMap((part, index) =>
    part.type !== 'text' ? [part] : index === firstText ? [{ type: 'text', text: edited }] : [],
  )
}

/** Splices the edited text into the message itself; false when it would change nothing. */
export function applyEditedPrompt(message: EditablePromptMessage, edited: string): boolean {
  const parts = editedPromptParts(message, edited)
  if (!parts) return false
  message.parts = parts
  return true
}
