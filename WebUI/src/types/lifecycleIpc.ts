import type { ArtifactRunMode } from './artifactIpc'

// In-flight Work (work the user started that has not finished) as the close question
// names it: one item per piece of work, rendered by the window into the close dialog's lines.

export type CloseChoice = 'keep' | 'quit'

export type InFlightWorkState =
  { status: 'running' } | { status: 'paused' } | { status: 'queued'; count?: number } | StepState

/** 1-based. */
export type StepState = { status: 'step'; index: number; count: number }

/** `taskId` / `sessionId` let main merge a run with its marker and its open agent turn. */
export type InFlightWorkItem =
  | { kind: 'agent-turn'; name?: string; state: InFlightWorkState }
  | { kind: 'chat-turn'; name?: string; state: InFlightWorkState }
  | { kind: 'home-agent-turn'; state: InFlightWorkState }
  | { kind: 'media-run'; mode: ArtifactRunMode; state: InFlightWorkState }
  | { kind: 'task-run'; taskId: string; sessionId?: string; name?: string; state: TaskRunWorkState }
  | { kind: 'prompt-run'; sessionId: string; name?: string; state: StepState }

/** A Task Run is `starting` while its models are checked, before its first Step exists. */
export type TaskRunWorkState = StepState | { status: 'starting' }

export type InFlightWorkKind = InFlightWorkItem['kind']

/** A chat turn the turn engine holds open. */
export type OpenChatTurn = { conversationKey: string; homeAgent: boolean; title?: string }

/** An artifact run the orchestrator has not settled: executing once admitted, else waiting. */
export type OpenArtifactRun = { mode: ArtifactRunMode; executing: boolean }

/** What the close dialog shows: the first few items, and how many it left out. */
export type CloseQuestion = {
  items: InFlightWorkItem[]
  more: number
}

export type CloseAskPayload = CloseQuestion & { requestId: string }

export type CloseAnswerPayload = { requestId: string; answer: CloseChoice }
