// Shared kernel event vocabulary (docs/architecture-target.md §4.6). Imported
// by the Electron main process (electron/kernel/kernelBus.ts) and the renderer
// projection (src/assets/js/projection/kernelProjection.ts). Main stamps
// `scope` and `seq`; the renderer's listener-first handshake installs a
// snapshot at sequence N and applies only events with a greater sequence.

import type { MediaItem } from './mediaItem'

export type KernelEventScope =
  { kind: 'global' } | { kind: 'chat'; conversationKey: string } | { kind: 'run'; runId: string }

/** One stream, one sequence: ordering across scopes is guaranteed too. */
export type KernelEventEnvelope = {
  scope: KernelEventScope
  seq: number
}

/** Backend service status. `info` is an `ApiServiceInformation` payload. */
export type KernelServiceEvent = {
  type: 'service'
  info: unknown
}

/** A running agent turn's translated UI message chunk. */
export type KernelAgentChunkEvent = {
  type: 'agent-chunk'
  turnId: string
  chunk: unknown
}

/** Streaming text output of one running tool, under its tool card. */
export type KernelAgentToolProgressEvent = {
  type: 'agent-tool-progress'
  turnId: string
  toolCallId: string
  toolName: string
  text: string
}

/** An image a tool produced, shown under that tool's card. */
export type KernelAgentToolImageEvent = {
  type: 'agent-tool-image'
  toolCallId: string
  dataUri: string
  label: string
}

/** The turn settled (success, error or abort); its stream can close. */
export type KernelAgentTurnDoneEvent = {
  type: 'agent-turn-done'
  turnId: string
}

// ── Artifact (media generation) events, docs/architecture-target.md §4.1 ──────
//
// The artifact runner in main owns the run lifecycle; the renderer's
// imageGenerationPresets store is a projection of these events.

/**
 * The run-level phase vocabulary (§4.1). These replace — rather than discard —
 * the renderer's `GenerateState`; the projection maps them onto the legacy
 * UI states so every consumer component keeps working.
 */
export type ArtifactPhase =
  | 'queued'
  | 'preparing-backend'
  | 'installing-components'
  | 'loading-components'
  | 'loading-model'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** Run-level phase transition for the artifact run main is executing. */
export type KernelArtifactPhaseEvent = {
  type: 'artifact-phase'
  runId: string
  phase: ArtifactPhase
  /** Execution progress for the `running` phase ("step 3 of 20"). */
  progress?: { current: number; max: number }
  /** Failure text for the `failed` phase. */
  error?: string
}

/**
 * One tracked media item of the active run: registration, a state/output
 * change or a terminal settle. `item` is the full `MediaItem` at its new state.
 */
export type KernelArtifactItemEvent = {
  type: 'artifact-item'
  runId: string
  item: MediaItem
}

/**
 * The run settled. Items already streamed via `artifact-item` (and are on the
 * snapshot), so this carries only the outcome and the failure text.
 */
export type KernelArtifactDoneEvent = {
  type: 'artifact-done'
  runId: string
  state: 'completed' | 'failed' | 'cancelled'
  error?: string
}

export type KernelEventPayload =
  | KernelServiceEvent
  | KernelAgentChunkEvent
  | KernelAgentToolProgressEvent
  | KernelAgentToolImageEvent
  | KernelAgentTurnDoneEvent
  | KernelArtifactPhaseEvent
  | KernelArtifactItemEvent
  | KernelArtifactDoneEvent

export type KernelEvent = KernelEventPayload & KernelEventEnvelope

/**
 * The accumulated state of the one agent turn main can be running, for a
 * renderer that (re)connects halfway through. Chunks are stored accumulated —
 * never as individual deltas to replay as events.
 */
export type AgentTurnSnapshot = {
  turnId: string
  chunks: unknown[]
  toolProgress: Record<string, string>
  toolImages: Record<string, KernelAgentToolImageEvent[]>
}

/**
 * The accumulated state of the one artifact run main can be executing, for a
 * renderer that (re)connects halfway through. Items are stored accumulated.
 */
export type ArtifactRunSnapshot = {
  runId: string
  /** Which driver surface submitted the run (panel mode or tool kind). */
  mode: WorkflowModeType
  workflow: string
  variant?: string
  phase: ArtifactPhase
  progress?: { current: number; max: number }
  error?: string | null
  items: MediaItem[]
}

export type KernelSnapshotState = {
  /** `ApiServiceInformation` payloads, keyed off the live service registry. */
  services: unknown[]
  activeTurn: AgentTurnSnapshot | null
  activeArtifactRun: ArtifactRunSnapshot | null
}

export type KernelSnapshot = {
  scope: { kind: 'global' }
  sequence: number
  state: KernelSnapshotState
}
