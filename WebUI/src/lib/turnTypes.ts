import type { UIMessage } from 'ai'
import type { AipgMetadata } from '@/assets/js/store/openAiCompatibleChat'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { ArtifactRunsState } from '@/lib/artifactRunProjection'
import type { AudioArtifact } from '@/lib/audioArtifacts'
import type {
  ArtifactProgress,
  ArtifactSize,
  GenerationFailure,
  TurnArtifact,
} from '@/lib/turnArtifacts'
import type { ArtifactPhase } from '@/types/kernelEvents'
import type { ComfyDynamicInputWithCurrent, GenerationSettings } from '@/types/mediaItem'
import type {
  AgentTurnTag,
  AudioTurnData,
  MediaTurnData,
  AgentRunTag,
  TimelineMessage,
} from '@/types/sessionTimeline'
import type { OverviewSummaryUpdate } from '@/types/sessionIpc'

export type TurnHintKind = 'chat' | 'agent' | 'workflow' | 'speech'
export type TurnHintIcon = 'chat' | 'agent' | 'image' | 'video' | 'tts' | 'stt'

export type TurnHint = { kind: TurnHintKind; icon: TurnHintIcon; preset: string; detail?: string }

/** A media workflow the turn's tools ran, named in the header beside the preset. */
export type TurnWorkflowHint = { preset: string; icon: 'image' | 'video'; variant?: string }

export type AnswerPartRef = { messageId: string; index: number }

export type AnswerDetailKind = 'reasoning' | 'tool' | 'generation' | 'compaction' | 'prose'

export type TurnDetailPart =
  | ({ kind: AnswerDetailKind } & AnswerPartRef)
  | { kind: 'workspace-path'; path: string }
  | {
      kind: 'overview-update'
      entryId: string
      update: OverviewSummaryUpdate
      covered?: { at: number; number: number }
    }
  | {
      kind: 'workflow'
      variant?: string
      settings: GenerationSettings
      inputs: ComfyDynamicInputWithCurrent[]
    }

export type TurnFailurePart = { kind: 'failure' } & GenerationFailure & Partial<AnswerPartRef>

export type TurnResultPart =
  | ({ kind: 'prose' | 'artifact' } & AnswerPartRef)
  | TurnFailurePart
  | { kind: 'media' }
  | { kind: 'audio' }

export type ArtifactKind = 'image' | 'video' | 'model3d' | 'audio'

export type TurnSummary =
  | {
      kind: 'activity'
      reasoningMs?: number
      tools?: number
      artifacts?: Partial<Record<ArtifactKind, number>>
    }
  | {
      kind: 'workflow'
      preset: string
      width?: number
      height?: number
      seed?: number
      durationMs?: number
    }
  | { kind: 'speech'; preset: string; engine?: string }

export type AudioPhase = 'loading-model' | 'generating' | 'transcribing'

export type TurnLiveStatus =
  | { kind: 'reasoning' }
  | { kind: 'writing' }
  | { kind: 'working' }
  | { kind: 'queued' }
  | { kind: 'stopping'; stillStopping: boolean }
  | { kind: 'tool'; name: string; label?: string; progress?: number }
  | { kind: 'activity'; label: string; progress?: number; browsing?: boolean }
  | { kind: 'artifact'; phase: ArtifactPhase; progress?: ArtifactProgress }
  | { kind: 'audio'; phase: AudioPhase }

export type TurnDetails = {
  parts: TurnDetailPart[]
  summary: TurnSummary
  /** Media workflows the turn's tools ran, so the header can name them unexpanded. */
  workflows?: TurnWorkflowHint[]
  live?: TurnLiveStatus
  error?: string
  /** One line under the header, for an error the Result does not already say. */
  errorLine?: string
}

/** Which Agent ran and what started it, shown in its Turn's prompt bubble. */
export type AgentRunIdentity = Pick<AgentRunTag, 'startedAt'> & {
  trigger: NonNullable<AgentRunTag['trigger']>
  channel?: AgentRunTag['channel']
  name: string
  agentId?: string
  /** The whole prompt the run started with, Steps included. */
  prompt: string
}

export type TurnPrompt = {
  text: string
  agentRun?: AgentRunIdentity
  placeholder?: string
  inputImageUrl?: string
  audio?: { url: string; name?: string }[]
  origin?: ChannelKind
}

export type TurnFooterAction = 'copy' | 'speak' | 'regenerate' | 'edit' | 'delete' | 'hide'

export type TurnMetrics = Pick<AipgMetadata, 'timings' | 'compute' | 'energy'>

/** What Delete takes out of a Harness Session: its messages, and the harness turns behind them. */
export type HarnessTurnRef = {
  harnessSessionId: string
  /** The prompt the Turn opened with, which Regenerate sends again. */
  promptId?: string
  messageIds: string[]
  turnIds: string[]
}

/** A settled media or speech turn's timeline messages, and the files only it produced. */
export type TurnRemoval = {
  messageIds: string[]
  fileUrls: string[]
}

export type TurnDeletion = { owner: 'media' | 'audio' } & TurnRemoval

/** Hidden messages stay in the Session's file and in what the model sees. */
export type TurnHiding = {
  messageIds: string[]
}

export type TurnFooter = {
  actions: TurnFooterAction[]
  text: string
  messageId?: string
  metrics?: TurnMetrics
  rerun?: MediaRerun
  audioRerun?: AudioRerun
  harnessTurn?: HarnessTurnRef
  deletion?: TurnDeletion
  hiding?: TurnHiding
}

/** Re-runs the latest Text-to-Speech / Speech-to-Text turn, which it replaces. */
export type AudioRerun = {
  kind: AudioTurnData['kind']
  preset: string
  /** TTS: the text spoken again; STT: what the source audio is called. */
  prompt: string
  /** TTS: the replaced clip; STT: the source clip to transcribe again. */
  audioUrl?: string
  messageIds: TurnRemoval['messageIds']
}

export type MediaRerun = {
  mode: MediaTurnData['mode']
  workflow: string
  variant?: string
  prompt: string
  negativePrompt?: string
  params: {
    seed: -1
    width?: number
    height?: number
    inferenceSteps?: number
    batchSize?: number
  }
  /** Workflow input values keyed `<nodeTitle>.<nodeInput>`. */
  inputs: Record<string, unknown>
  inputImageUrl?: string
} & TurnRemoval

export type TurnOf<K extends string, Body> = {
  kind: K
  id: string
  hint: TurnHint
  details: TurnDetails
  result: TurnResultPart[]
  footer: TurnFooter
  /** The History Entry this turn settled as, when the timeline carries it. */
  historyEntryId?: string
} & Body

/** A chat or agent Turn opened by an answer has no prompt. */
export type ChatTurn = TurnOf<
  'chat',
  {
    prompt?: TurnPrompt
    answers: UIMessage[]
    artifacts: TurnArtifact[]
    audioArtifacts: AudioArtifact[]
    questionKey?: string
  }
>

export type AgentTurn = TurnOf<
  'agent',
  {
    presetName: string
    harnessSessionId: string
    /** Set on an Agent Run's Turns outside its Follow-ups, and on older Sessions' run prompts. */
    runKey?: string
    prompt?: TurnPrompt
    answers: UIMessage[]
    artifacts: TurnArtifact[]
    audioArtifacts: AudioArtifact[]
    streaming?: boolean
    queued?: boolean
    notRun?: boolean
    canResend?: boolean
    questionKey?: string
  }
>

export type MediaTurn = TurnOf<
  'media',
  {
    prompt: TurnPrompt
    /** The turn's own user prompt message; `id` is its answer. */
    promptId: string
    createdAt: number
    media: MediaTurnData
    artifacts: TurnArtifact[]
  }
>

export type AudioTurn = TurnOf<
  'audio',
  {
    prompt: TurnPrompt
    createdAt: number
    audio: AudioTurnData
    audioArtifacts: AudioArtifact[]
    /** The turn's own user prompt message; `id` is its answer. */
    promptId: string
  }
>

export type MessageTurn = { kind: 'message'; id: string; message: TimelineMessage }

export type TimelineTurn = ChatTurn | AgentTurn | MediaTurn | AudioTurn | MessageTurn

export type LiveAgentTurn = {
  tag: AgentTurnTag
  messages: readonly { id: string }[]
  live: boolean
  queuedMessageId?: string
  notRunMessageId?: string
  canResend?: boolean
  open?: boolean
  error?: string
}

export type PendingMedia = {
  runId: string
  preset: string
  mode: MediaTurnData['mode']
  prompt?: string
  inputImageUrl?: string
  /** What was asked for, so placeholders hold the result's box before the run registers items. */
  size?: ArtifactSize
  batchSize?: number
}

export type PendingAudio = {
  kind: AudioTurnData['kind']
  preset: string
  prompt?: string
  phase?: AudioPhase
}

export type LiveChatStatus = {
  running: boolean
  activity?: { label: string; progress?: number; browsing?: boolean } | null
  questionKey?: string
  /** Why the newest chat turn failed, until the next one starts. */
  error?: string
  /** The newest chat turn was stopped by the user, until the next one starts. */
  cancelled?: boolean
}

export type MediaStepStatus = { label: string; progress?: number }

/** A live Agent Turn that is Stopping: its Harness Session, and when the stop was asked for. */
export type AgentStopping = { harnessSessionId: string; at: number }

/** When the user asked to stop each kind of live Turn, while main has not released it. */
export type LiveStopping = {
  chatStoppingAt?: number
  agentStopping?: AgentStopping
  mediaStoppingAt?: number
  audioStoppingAt?: number
}

export type LiveTurns<M extends PendingMedia, A extends PendingAudio> = LiveStopping & {
  chat?: readonly { id: string }[]
  agents?: readonly LiveAgentTurn[]
  /** Run keys of the Agent Runs still in flight. */
  agentRunsInFlight?: readonly string[]
  chatStatus?: LiveChatStatus
  /** The time the Stopping escalation is measured against; a view supplies its ticking clock. */
  now?: number
  media?: M | null
  mediaSteps?: Readonly<Record<string, MediaStepStatus>>
  audio?: A | null
  artifactRuns?: ArtifactRunsState
}

export type TimelineFiles = {
  deletedUrls?: readonly string[]
}

export type SessionTimelineItem<M = PendingMedia, A = PendingAudio> =
  | TimelineTurn
  | TurnOf<'pending-media', { prompt: TurnPrompt; pending: M; artifacts: TurnArtifact[] }>
  | TurnOf<'pending-audio', { prompt: TurnPrompt; pending: A; audioArtifacts: AudioArtifact[] }>
