/**
 * The conversation title as the UI defines it: the first message's
 * `conversationTitle` metadata (set on rename, or the summary).
 */
export function titleFromMessages(messages: unknown[]): string | undefined {
  const first = messages[0] as { metadata?: { conversationTitle?: unknown } } | undefined
  const title = first?.metadata?.conversationTitle
  return typeof title === 'string' && title.length > 0 ? title : undefined
}
