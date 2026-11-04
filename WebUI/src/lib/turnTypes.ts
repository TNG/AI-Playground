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

export type TurnHint = { kind: TurnHintKind; icon: TurnHintIcon; preset: string; detail?: string }

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
  | { kind: 'tool'; name: string; label?: string; progress?: number }
  | { kind: 'activity'; label: string; progress?: number; browsing?: boolean }
  | { kind: 'artifact'; phase: ArtifactPhase; progress?: ArtifactProgress }
  | { kind: 'audio'; phase: AudioPhase }

export type TurnDetails = {
  parts: TurnDetailPart[]
  summary: TurnSummary
  live?: TurnLiveStatus
  error?: string
  /** One line under the header, for an error the Result does not already say. */
  errorLine?: string
}
export type TurnPrompt = {
  text: string
  placeholder?: string
  inputImageUrl?: string
  audio?: { url: string; name?: string }[]
  origin?: ChannelKind
}

export type TurnFooterAction = 'copy' | 'speak' | 'regenerate' | 'delete'

export type TurnMetrics = Pick<AipgMetadata, 'timings' | 'compute' | 'energy'>

export type TurnFooter = {
  actions: TurnFooterAction[]
  text: string
  messageId?: string
  metrics?: TurnMetrics
  rerun?: MediaRerun
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
}

export type TurnOf<K extends string, Body> = {
  kind: K
  id: string
  hint: TurnHint
  details: TurnDetails
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
    artifacts: TurnArtifact[]
    audioArtifacts: AudioArtifact[]
    taskRun?: TaskRunTag
    streaming?: boolean
    queued?: boolean
    notRun?: boolean
    canResend?: boolean
    questionKey?: string
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

export type MessageTurn = { kind: 'message'; id: string; message: TimelineMessage }

export type TimelineTurn = ChatTurn | AgentTurn | MediaTurn | AudioTurn | MessageTurn

export type TaskRunItem = {
  kind: 'task-run'
  id: string
  harnessSessionId: string
  taskRun: TaskRunTag
  turns: AgentTurn[]
  resultTurns: AgentTurn[]
  live: boolean
}

export type LiveAgentTurn = {
  tag: AgentTurnTag
  messages: readonly { id: string }[]
  live: boolean
  queuedMessageId?: string
  notRunMessageId?: string
  canResend?: boolean
  open?: boolean
  heldAnswer?: { channel: ChannelKind }
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
}

export type MediaStepStatus = { label: string; progress?: number }

export type LiveTurns<M extends PendingMedia, A extends PendingAudio> = {
  chat?: readonly { id: string }[]
  agents?: readonly LiveAgentTurn[]
  chatStatus?: LiveChatStatus
  media?: M | null
  mediaSteps?: Readonly<Record<string, MediaStepStatus>>
  audio?: A | null
  artifactRuns?: ArtifactRunsState
}

export type TimelineEntry = TimelineTurn | TaskRunItem

export type TimelineFiles = {
  deletedUrls?: readonly string[]
}

export type SessionTimelineItem<M = PendingMedia, A = PendingAudio> =
  | TimelineEntry
  | TurnOf<'pending-media', { prompt: TurnPrompt; pending: M; artifacts: TurnArtifact[] }>
  | TurnOf<'pending-audio', { prompt: TurnPrompt; pending: A; audioArtifacts: AudioArtifact[] }>
