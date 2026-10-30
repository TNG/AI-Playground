import { appLoggerInstance } from '../observability/logger.ts'
import { LOG_SOURCE } from './piAgentLog.ts'

export type AgentTurnOutcome = 'completed' | 'failed' | 'cancelled'

/** `error` is the text the app shows for the failure; `reply` is the turn's last assistant text. */
export type AgentTurnEnd = { sessionId: string; turnId: string } & (
  | { outcome: 'completed'; reply?: string }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; error: string }
)

type AgentTurnEndListener = (end: AgentTurnEnd) => void

const listeners = new Set<AgentTurnEndListener>()

export function onAgentTurnEnd(listener: AgentTurnEndListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function reportAgentTurnEnd(end: AgentTurnEnd): void {
  for (const listener of listeners) {
    try {
      listener(end)
    } catch (error) {
      appLoggerInstance.warn(`agent turn end listener failed: ${error}`, LOG_SOURCE)
    }
  }
}
