// What the prompt bar's Stop acts on: the prompt it holds, the open Agent Run, or the open
// Session's Turn. A Turn this mode owns is stopped by the mode's cancel callback; any other
// kind is stopped through the Session ledger.

import type { SessionTurnKind } from '@/types/sessionIpc'

export type CancelableTurn = {
  turnId: string
  kind: SessionTurnKind
  harnessSessionId?: string
}

export type CancelPlan =
  | { kind: 'queued-prompt' }
  | { kind: 'agent-run' }
  | { kind: 'mode'; turn: CancelableTurn | null }
  | { kind: 'ledger'; turn: CancelableTurn }

export type CancelInput = {
  queuedBehindRun: boolean
  agentRunInSession: boolean
  turn: CancelableTurn | null
  mode: ModeType
  openAgentSessionId: string | null
}

export function planCancel(input: CancelInput): CancelPlan {
  if (input.queuedBehindRun) return { kind: 'queued-prompt' }
  if (input.agentRunInSession) return { kind: 'agent-run' }
  const { turn } = input
  if (!turn || ownsTurn(turn, input)) return { kind: 'mode', turn }
  return { kind: 'ledger', turn }
}

function ownsTurn(turn: CancelableTurn, input: CancelInput): boolean {
  if (turn.kind === 'chat') return input.mode === 'chat'
  if (turn.kind === 'audio') return input.mode === 'audio'
  if (turn.kind === 'media') {
    return input.mode === 'imageGen' || input.mode === 'imageEdit' || input.mode === 'video'
  }
  return input.mode === 'agent' && turn.harnessSessionId === input.openAgentSessionId
}
