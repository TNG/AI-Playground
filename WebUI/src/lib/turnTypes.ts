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
  TaskRunTag,
  TimelineMessage,
} from '@/types/sessionTimeline'

export type TurnHintKind = 'chat' | 'agent' | 'workflow' | 'speech'
export type TurnHintIcon = 'chat' | 'agent' | 'image' | 'video' | 'tts' | 'stt'

/** Which preset ran a Turn: its kind and name, with the model or engine for the tooltip. */
export type TurnHint = { kind: TurnHintKind; icon: TurnHintIcon; preset: string; detail?: string }

/** One part of a chat or agent answer, by its place in the message. */
export type AnswerPartRef = { messageId: string; index: number }

export type AnswerDetailKind = 'reasoning' | 'tool' | 'generation' | 'compaction'

export type TurnDetailPart =
  | ({ kind: AnswerDetailKind } & AnswerPartRef)
  | { kind: 'workspace-path'; path: string }
  | {
      kind: 'workflow'
      variant?: string
      settings: GenerationSettings
      inputs: ComfyDynamicInputWithCurrent[]
    }

/** A generation that ended before it produced anything, said in one line where its card would be. */
export type TurnFailurePart = { kind: 'failure' } & GenerationFailure & Partial<AnswerPartRef>

export type TurnResultPart =
  | ({ kind: 'prose' | 'artifact' } & AnswerPartRef)
  | TurnFailurePart
  | { kind: 'media' }
  | { kind: 'audio' }

export type ArtifactKind = 'image' | 'video' | 'model3d' | 'audio'

/** What the collapsed Turn Details header sums up; absent parts are left out. */
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

/** What a running Turn is doing right now, said by its Turn Details header in place of the summary. */
export type TurnLiveStatus =
  | { kind: 'reasoning' }
  | { kind: 'writing' }
  | { kind: 'working' }
  | { kind: 'queued' }
  | { kind: 'tool'; name: string; label?: string; progress?: number }
  /** A status worded where it was raised (backend prep, RAG, browsing). */
  | { kind: 'activity'; label: string; progress?: number; browsing?: boolean }
  | { kind: 'artifact'; phase: ArtifactPhase; progress?: ArtifactProgress }
  | { kind: 'audio'; phase: AudioPhase }

/** How a Turn reached its Result, in the order it happened, behind one disclosure. */
export type TurnDetails = {
  parts: TurnDetailPart[]
  summary: TurnSummary
  /** Set only while the Turn runs. */
  live?: TurnLiveStatus
  /** Every error of the Turn in full: a failed generation's, the run's own. */
  error?: string
  /** One line under the header, for an error the Result does not already say. */
  errorLine?: string
}
/** The user bubble: what was asked, and what it was asked about. */
export type TurnPrompt = {
  text: string
  /** Shown in place of a prompt left empty: the preset that ran. */
  placeholder?: string
  inputImageUrl?: string
  audio?: { url: string; name?: string }[]
  /** The chat platform an agent prompt arrived from. */
  origin?: ChannelKind
}

export type TurnFooterAction = 'copy' | 'speak' | 'regenerate' | 'delete'

export type TurnMetrics = Pick<AipgMetadata, 'timings' | 'compute' | 'energy'>

/** The actions that apply to a Turn, and what it cost where that is known. */
export type TurnFooter = {
  actions: TurnFooterAction[]
  /** What Copy and Speak take. */
  text: string
  /** The chat answer Speak, Regenerate and Delete act on. */
  messageId?: string
  metrics?: TurnMetrics
  /** What Regenerate submits for a ComfyUI Turn. */
  rerun?: MediaRerun
}

/** A ComfyUI Turn's preset, variant, settings and inputs as recorded, with a new seed. */
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
  /** The image the rerun starts from, for its Turn's user bubble. */
  inputImageUrl?: string
}

/**
 * One prompt and what it produced. `SessionTurn.vue` lays every kind out the same way —
 * prompt, hint, Turn Details, Result, footer — and the fields of each kind fill those slots.
 */
export type TurnOf<K extends string, Body> = {
  kind: K
  id: string
  hint: TurnHint
  details: TurnDetails
  /** Prose and artifacts in the order they were produced. */
  result: TurnResultPart[]
  footer: TurnFooter
} & Body

/** A chat or agent Turn opened by an answer has no prompt. */
export type ChatTurn = TurnOf<
  'chat',
  {
    prompt?: TurnPrompt
    answers: UIMessage[]
    artifacts: TurnArtifact[]
    audioArtifacts: AudioArtifact[]
    /** The conversation a tool's question to the user is filed under, while the Turn runs. */
    questionKey?: string
  }
>

export type AgentTurn = TurnOf<
  'agent',
  {
    presetName: string
    harnessSessionId: string
    prompt?: TurnPrompt
    answers: UIMessage[]
    /** What its settled media tool calls produced. */
    artifacts: TurnArtifact[]
    audioArtifacts: AudioArtifact[]
    taskRun?: TaskRunTag
    /** The answer is streaming right now. */
    streaming?: boolean
    /** The prompt waits in the Turn Queue. */
    queued?: boolean
    /** The prompt never ran (the app closed first). */
    notRun?: boolean
    canResend?: boolean
    /** The conversation a tool's question to the user is filed under. */
    questionKey?: string
    /** An answer for a chat platform, held until the user lets it go. */
    heldAnswer?: { channel: ChannelKind }
  }
>

export type MediaTurn = TurnOf<
  'media',
  { prompt: TurnPrompt; createdAt: number; media: MediaTurnData; artifacts: TurnArtifact[] }
>

export type AudioTurn = TurnOf<
  'audio',
  { prompt: TurnPrompt; createdAt: number; audio: AudioTurnData; audioArtifacts: AudioArtifact[] }
>

/** A saved message that answers no prompt the timeline knows. */
export type MessageTurn = { kind: 'message'; id: string; message: TimelineMessage }

export type TimelineTurn = ChatTurn | AgentTurn | MediaTurn | AudioTurn | MessageTurn

/** A scheduled run of an Agent: a collapsible container of its Turns. */
export type TaskRunItem = {
  kind: 'task-run'
  id: string
  harnessSessionId: string
  taskRun: TaskRunTag
  turns: AgentTurn[]
  /** The Turns with a Result, which still shows while the run is collapsed. */
  resultTurns: AgentTurn[]
  live: boolean
}

/** A Harness Session's live transcript, streamed into the timeline. */
export type LiveAgentTurn = {
  tag: AgentTurnTag
  messages: readonly { id: string }[]
  live: boolean
  queuedMessageId?: string
  notRunMessageId?: string
  canResend?: boolean
  /** The Harness Session open in Agent Mode, the one that can ask the user a question. */
  open?: boolean
  heldAnswer?: { channel: ChannelKind }
  /** Why its last turn failed. */
  error?: string
}

/** What the timeline needs of a ComfyUI run still in flight. */
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

/** What the timeline needs of an audio turn still running. */
export type PendingAudio = {
  kind: AudioTurnData['kind']
  preset: string
  prompt?: string
  phase?: AudioPhase
}

/** What the Session's chat turn is doing, when one runs. */
export type LiveChatStatus = {
  running: boolean
  activity?: { label: string; progress?: number; browsing?: boolean } | null
  questionKey?: string
}

/** The step a media specialist is on, by the tool call that delegated to it. */
export type MediaStepStatus = { label: string; progress?: number }

/** Everything of the open Session still in flight, whichever preset or mode started it. */
export type LiveTurns<M extends PendingMedia, A extends PendingAudio> = {
  /** The Session's chat transcript as the chat store holds it, streaming turn included. */
  chat?: readonly { id: string }[]
  /** Each Harness Session of the Session that is open or running a turn (Task Runs too). */
  agents?: readonly LiveAgentTurn[]
  chatStatus?: LiveChatStatus
  media?: M | null
  mediaSteps?: Readonly<Record<string, MediaStepStatus>>
  audio?: A | null
  /** Artifact runs in flight or recently settled, whichever surface started them. */
  artifactRuns?: ArtifactRunsState
}

/** What the timeline lays out top to bottom: Turns, and Task Runs holding theirs. */
export type TimelineEntry = TimelineTurn | TaskRunItem

/** What the Session Folder says about the timeline's files. */
export type TimelineFiles = {
  /** Main-file URLs whose file is gone. */
  deletedUrls?: readonly string[]
}

export type SessionTimelineItem<M = PendingMedia, A = PendingAudio> =
  | TimelineEntry
  | TurnOf<'pending-media', { prompt: TurnPrompt; pending: M; artifacts: TurnArtifact[] }>
  | TurnOf<'pending-audio', { prompt: TurnPrompt; pending: A; audioArtifacts: AudioArtifact[] }>
