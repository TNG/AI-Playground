/**
 * Where a prompt for a turn may be shown. A paused Agent Session's download or
 * VRAM prompt waits until that session is on screen rather than popping up over
 * whatever the user is doing; Agent Mode registers the port, and anything it does
 * not know (Chat, panels, no turn at all) is shown at once.
 */
export type SessionPromptPort = {
  /** Resolves once `conversationKey`'s session is in view; rejects if its turn ends first. */
  whenInView: (conversationKey: string) => Promise<void>
}

let registered: SessionPromptPort | null = null

export function registerSessionPromptPort(port: SessionPromptPort | null): void {
  registered = port
}

export function whenSessionInView(conversationKey: string | undefined): Promise<void> {
  if (!conversationKey || !registered) return Promise.resolve()
  return registered.whenInView(conversationKey)
}
