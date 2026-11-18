import type { SendToSessionResult, TurnOutcome } from '@/assets/js/store/agentMode'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTaskStep } from '@/types/agentTaskIpc'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { firstStepTurn, runPrompt, stepPrompts, stepTurn } from '@/lib/taskSteps'

/** What sends a Step's turn: the Agent Mode store. */
export type StepSender = {
  sendToSession: (
    sessionId: string,
    prompt: string,
    options: {
      settings: AgentSessionSettings
      signal: AbortSignal
      quietErrors: boolean
      answer?: AgentAnswerOrigin
      taskRun: { taskName: string; stepIndex: number; notifiesResult?: boolean }
    },
  ) => Promise<SendToSessionResult>
}

export type RunStep = {
  sessionId: string
  stepIndex: number
  taskName: string
  steps: readonly AgentTaskStep[]
  settingsTemplate: AgentSessionSettings
  signal: AbortSignal
  /** A Scheduled Run, whose last Step sends its result to every Channel. */
  scheduled?: boolean
  /** The user's message, framing Step 1. */
  prompt?: string
  /** Where a Channel-started run came from: its Steps report there, its last Step the result. */
  origin?: AgentAnswerOrigin
}

/** Send one Step of an Agent Run or Trial Run; a refusal other than an abort fails the run. */
export async function sendRunStep(
  sender: StepSender,
  step: RunStep,
  onFailed: (message: string) => unknown,
): Promise<void> {
  const steps = stepPrompts(step.steps)
  const turn =
    step.stepIndex === 1 ? firstStepTurn(step.prompt ?? '', steps) : stepTurn(step.stepIndex, steps)
  const result = await sender.sendToSession(step.sessionId, turn, {
    settings: cloneForIpc(step.settingsTemplate),
    signal: step.signal,
    quietErrors: true,
    ...(step.origin ? { answer: step.origin } : {}),
    taskRun: {
      taskName: step.taskName,
      stepIndex: step.stepIndex,
      ...((step.scheduled || step.origin) && step.stepIndex === steps.length
        ? { notifiesResult: true }
        : {}),
    },
  })
  if (!result.ok && result.reason !== 'aborted') await onFailed(result.message)
}

export type RunTurn = Omit<RunStep, 'stepIndex'>

/** Send an Agent Run's one turn, all its Steps at once; a refusal other than an abort fails it. */
export async function sendRunTurn(
  sender: StepSender,
  run: RunTurn,
  onFailed: (message: string) => unknown,
): Promise<void> {
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
        stepIndex: 1,
        ...(run.scheduled || run.origin ? { notifiesResult: true } : {}),
      },
    },
  )
  if (!result.ok && result.reason !== 'aborted') await onFailed(result.message)
}

export type RunTurnEnd = Exclude<AfterStepTurn, { kind: 'step' }>

/** How an Agent Run ended, from its one turn. */
export function afterRunTurn(outcome: TurnOutcome): RunTurnEnd {
  if (outcome.kind === 'error') return { kind: 'failed', message: outcome.message }
  return outcome.kind === 'completed' ? { kind: 'completed' } : { kind: 'stopped' }
}

export type AfterStepTurn =
  | { kind: 'step'; stepIndex: number }
  | { kind: 'completed' }
  | { kind: 'failed'; message: string }
  | { kind: 'stopped' }

/** What a run does once a Step's turn settled. */
export function afterStepTurn(
  outcome: TurnOutcome,
  stepIndex: number,
  stepCount: number,
): AfterStepTurn {
  const end = afterRunTurn(outcome)
  return end.kind === 'completed' && stepIndex < stepCount
    ? { kind: 'step', stepIndex: stepIndex + 1 }
    : end
}
