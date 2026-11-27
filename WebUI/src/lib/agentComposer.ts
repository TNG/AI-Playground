import type { AgentRunTag } from '@/types/agentSessionIpc'

export type LatestAgentRun = Pick<AgentRunTag, 'startedAt'> & {
  harnessSessionId: string
}

/** The Session's newest turn: its Harness Session when it has one, and what ran it. */
export type LatestTurn = { harnessSessionId?: string; ranBy: string }

export type AgentComposerInput = {
  latestRun?: LatestAgentRun
  latestTurn?: LatestTurn
  /** The Agent a new run would use is not the one its latest run used. */
  agentEdited: boolean
}

export type AgentComposerReason = 'never-run' | 'other-turn' | 'agent-edited'

export type AgentComposerState = {
  primary: 'run' | 'send'
  sendEnabled: boolean
  reason?: AgentComposerReason
  ranSince?: string
}

/** Which of Run and Send Enter triggers with an Agent picked (ADR 0008). */
export function agentComposerState(input: AgentComposerInput): AgentComposerState {
  const { latestRun, latestTurn, agentEdited } = input
  if (!latestRun) return { primary: 'run', sendEnabled: false, reason: 'never-run' }
  if (latestTurn && latestTurn.harnessSessionId !== latestRun.harnessSessionId) {
    return { primary: 'run', sendEnabled: true, reason: 'other-turn', ranSince: latestTurn.ranBy }
  }
  if (agentEdited) {
    return { primary: 'run', sendEnabled: true, reason: 'agent-edited' }
  }
  return { primary: 'send', sendEnabled: true }
}
