// Shared kernel event vocabulary (docs/architecture-target.md §4.6). Imported
// by the Electron main process (electron/kernel/kernelBus.ts) and the renderer
// projection (src/assets/js/projection/kernelProjection.ts). Main stamps
// `scope` and `seq`; the renderer's listener-first handshake installs a
// snapshot at sequence N and applies only events with a greater sequence.

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

export type KernelEventPayload =
  | KernelServiceEvent
  | KernelAgentChunkEvent
  | KernelAgentToolProgressEvent
  | KernelAgentToolImageEvent
  | KernelAgentTurnDoneEvent

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

export type KernelSnapshotState = {
  /** `ApiServiceInformation` payloads, keyed off the live service registry. */
  services: unknown[]
  activeTurn: AgentTurnSnapshot | null
}

export type KernelSnapshot = {
  scope: { kind: 'global' }
  sequence: number
  state: KernelSnapshotState
}
