import type { AgentAnswerOrigin } from '@/types/agentIpc'

/**
 * Where a prompt for a turn may be shown. A paused Agent Session's download or
 * VRAM prompt waits until that session is on screen rather than popping up over
 * whatever the user is doing; Agent Mode registers the port, and anything it does
 * not know (Chat, panels, no turn at all) is shown at once.
 */
export type SessionPromptPort = {
  /** Resolves once `conversationKey`'s session is in view; rejects if its turn ends first. */
  whenInView: (conversationKey: string) => Promise<void>
  /** `conversationKey` is an Agent Mode session with a turn in flight. */
  isAgentTurn: (conversationKey: string) => boolean
  /** Resolves once that session's turn has ended (stopped, finished, failed or deleted). */
  whenTurnEnds: (conversationKey: string) => Promise<void>
  /** The channel Answer that started that session's turn in flight, if one did. */
  answerOrigin: (conversationKey: string) => AgentAnswerOrigin | undefined
}

let registered: SessionPromptPort | null = null
let labeler: ((conversationKey: string) => string) | null = null

export function registerSessionPromptPort(port: SessionPromptPort | null): void {
  registered = port
}

export function whenSessionInView(conversationKey: string | undefined): Promise<void> {
  if (!conversationKey || !registered) return Promise.resolve()
  return registered.whenInView(conversationKey)
}

/** Never resolves for a turn no session owns. */
export function whenSessionTurnEnds(conversationKey: string): Promise<void> {
  return registered?.whenTurnEnds(conversationKey) ?? new Promise<void>(() => {})
}

export function isAgentSessionTurn(conversationKey: string | undefined): boolean {
  return !!conversationKey && !!registered?.isAgentTurn(conversationKey)
}

export function sessionAnswerOrigin(conversationKey: string): AgentAnswerOrigin | undefined {
  return registered?.answerOrigin(conversationKey)
}

/** Names a session or Task run the way Notifications do. */
export function registerSessionLabeler(next: ((conversationKey: string) => string) | null): void {
  labeler = next
}

export function sessionLabel(conversationKey: string): string {
  return labeler?.(conversationKey) ?? ''
}
