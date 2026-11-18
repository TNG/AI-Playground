import type { SendToSessionResult, TurnOutcome } from '@/assets/js/store/agentMode'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTaskStep } from '@/types/agentTaskIpc'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { runPrompt, stepPrompts } from '@/lib/taskSteps'

/** What sends an Agent Run's turn: the Agent Mode store. */
export type StepSender = {
  sendToSession: (
    sessionId: string,
    prompt: string,
    options: {
      settings: AgentSessionSettings
      signal: AbortSignal
      quietErrors: boolean
      answer?: AgentAnswerOrigin
      taskRun: { taskName: string; input?: string; notifiesResult?: boolean }
    },
  ) => Promise<SendToSessionResult>
}

export type RunTurn = {
  sessionId: string
  taskName: string
  steps: readonly AgentTaskStep[]
  settingsTemplate: AgentSessionSettings
  signal: AbortSignal
  /** A Scheduled Run, whose turn sends its result to every Channel. */
  scheduled?: boolean
  /** The user's Start Prompt, adjusting the Steps. */
  prompt?: string
  /** Where a Channel-started run came from: its result is reported there. */
  origin?: AgentAnswerOrigin
}

/** Send an Agent Run's one turn, all its Steps at once; a refusal other than an abort fails it. */
export async function sendRunTurn(
  sender: StepSender,
  run: RunTurn,
  onFailed: (message: string) => unknown,
): Promise<void> {
  const input = run.prompt?.trim()
  const result = await sender.sendToSession(
    run.sessionId,
    runPrompt(run.prompt ?? '', stepPrompts(run.steps)),
    {
      settings: cloneForIpc(run.settingsTemplate),
      signal: run.signal,
      quietErrors: true,
      ...(run.origin ? { answer: run.origin } : {}),
      taskRun: {
        taskName: run.taskName,
        ...(input ? { input } : {}),
        ...(run.scheduled || run.origin ? { notifiesResult: true } : {}),
      },
    },
  )
  if (!result.ok && result.reason !== 'aborted') await onFailed(result.message)
}

export type RunTurnEnd =
  { kind: 'completed' } | { kind: 'failed'; message: string } | { kind: 'stopped' }

/** How an Agent Run ended, from its one turn. */
export function afterRunTurn(outcome: TurnOutcome): RunTurnEnd {
  if (outcome.kind === 'error') return { kind: 'failed', message: outcome.message }
  return outcome.kind === 'completed' ? { kind: 'completed' } : { kind: 'stopped' }
}
