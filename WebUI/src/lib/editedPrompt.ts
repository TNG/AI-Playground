/**
 * Prompt editing for a turn's re-run: the user rewords the prompt of the
 * last turn and the turn runs again from the edited text. What reaches the
 * model is the message list as it stands by the time the turn is sent, so
 * editing is a splice of the message's text parts — a single edited text
 * part in place of the old ones, with every attached file kept as it is.
 */

type PartWithText = { type: string; text?: string }

export type EditablePromptMessage = { parts: PartWithText[] }

/**
 * The message's parts with its text replaced by `edited`: the first text
 * part's slot carries the new text and the remaining text parts drop out,
 * while non-text parts (images, audio, files) stay where they were.
 */
export function editedPromptParts(
  message: EditablePromptMessage | undefined,
  edited: string,
): PartWithText[] | null {
  if (!message) return null
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
export function applyEditedPrompt(
  message: EditablePromptMessage | undefined,
  edited: string,
): boolean {
  if (!message) return false
  const parts = editedPromptParts(message, edited)
  if (!parts) return false
  message.parts = parts
  return true
}
