import type { AnswerSessions } from './answerRouter'

// Agent Mode registers here because the Home Agent store cannot import it (import cycle).

let registered: AnswerSessions | null = null

export function registerAnswerSessions(port: AnswerSessions | null): void {
  registered = port
}

export function answerSessions(): AnswerSessions | null {
  return registered
}
