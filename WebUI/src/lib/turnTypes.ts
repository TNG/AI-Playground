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

export type TurnHintKind = 'chat' | 'agent' | 'workflow' | 'speech'
export type TurnHintIcon = 'chat' | 'agent' | 'image' | 'video' | 'tts' | 'stt'

export type TurnHint = { kind: TurnHintKind; icon: TurnHintIcon; preset: string; detail?: string }

export type AnswerPartRef = { messageId: string; index: number }

export type AnswerDetailKind = 'reasoning' | 'tool' | 'generation' | 'compaction' | 'prose'

export type TurnDetailPart =
  | ({ kind: AnswerDetailKind } & AnswerPartRef)
  | { kind: 'workspace-path'; path: string }
  | { kind: 'step-prompt'; step: number; prompt: TurnPrompt }
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
      /** Set on an Agent Run: how many of its Steps have started. */
      steps?: number
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

export type RunProgress = { step: number; count: number }

export type TurnDetails = {
  parts: TurnDetailPart[]
  summary: TurnSummary
  live?: TurnLiveStatus
  /** Which Step of an Agent Run, or a Run steps run, is under way. */
  progress?: RunProgress
  error?: string
  /** One line under the header, for an error the Result does not already say. */
  errorLine?: string
}

/** Which Agent ran and what started it, shown in its Turn's prompt bubble. */
export type AgentRunIdentity = Pick<AgentRunTag, 'startedAt'> & {
  trigger: NonNullable<AgentRunTag['trigger']>
  name: string
  agentId?: string
}

export type TurnPrompt = {
  text: string
  /** Set on a Trial Run's Step, whose bubble is labelled with it. */
  step?: number
  agentRun?: AgentRunIdentity
  placeholder?: string
  inputImageUrl?: string
  audio?: { url: string; name?: string }[]
  origin?: ChannelKind
}

export type TurnFooterAction = 'copy' | 'speak' | 'regenerate' | 'delete'

export type TurnMetrics = Pick<AipgMetadata, 'timings' | 'compute' | 'energy'>

/** What Delete takes out of a Harness Session: its messages, and the harness turns behind them. */
export type HarnessTurnRef = { harnessSessionId: string; messageIds: string[]; turnIds: string[] }

export type TurnFooter = {
  actions: TurnFooterAction[]
  text: string
  messageId?: string
  metrics?: TurnMetrics
  rerun?: MediaRerun
  harnessTurn?: HarnessTurnRef
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
    /** Set on an Agent Run's Turn, or a Run steps run's: what its Steps are grouped by. */
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
  /** Why the newest chat turn failed, until the next one starts. */
  error?: string
}

export type MediaStepStatus = { label: string; progress?: number }

export type LiveTurns<M extends PendingMedia, A extends PendingAudio> = {
  chat?: readonly { id: string }[]
  agents?: readonly LiveAgentTurn[]
  /** Runs still in flight, including between two Steps, by run key. */
  agentRunsInFlight?: Readonly<Record<string, RunProgress>>
  chatStatus?: LiveChatStatus
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
