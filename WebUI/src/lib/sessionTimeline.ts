import type { UIMessage } from 'ai'
import type {
  AgentTurnTag,
  AudioTurnData,
  MediaTurnData,
  TaskRunTag,
  TimelineMessage,
  TimelinePart,
} from '@/types/sessionTimeline'
import type { ComfyDynamicInputWithCurrent, GenerationSettings } from '@/types/mediaItem'
import {
  compactionOutputOf,
  generatedMediaOf,
  isReasoningPart,
  mediaToolNameOf,
  toolPartNameOf,
} from '@/lib/agentTranscript'
import { isChatMediaToolPart } from '@/lib/chatToolParts'
import { reasoningElapsedMsFromParts } from '@/lib/reasoningTimings'
import type { AipgMetadata } from '@/assets/js/store/openAiCompatibleChat'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { messageHasVisibleContent, messageText } from '@/lib/chatMessageText'
import { asChatTranscriptMessage } from '@/lib/sessionChat'
import type { ArtifactRunsState } from '@/lib/artifactRunProjection'
import {
  placeholderArtifacts,
  runArtifacts,
  toolCallArtifacts,
  turnArtifacts,
  type ArtifactSize,
  type TurnArtifact,
} from '@/lib/turnArtifacts'
import {
  audioTurnArtifacts,
  pendingAudioArtifacts,
  ttsToolArtifacts,
  type AudioArtifact,
  type AudioTurnPhase,
} from '@/lib/audioArtifacts'

export type TurnHintKind = 'chat' | 'agent' | 'workflow' | 'speech'
export type TurnHintIcon = 'chat' | 'agent' | 'image' | 'video' | 'tts' | 'stt'

/** Which preset ran a Turn: its kind and name, with the model or engine for the tooltip. */
export type TurnHint = { kind: TurnHintKind; icon: TurnHintIcon; preset: string; detail?: string }

/** One part of a chat or agent answer, by its place in the message. */
export type AnswerPartRef = { messageId: string; index: number }

type AnswerDetailKind = 'reasoning' | 'tool' | 'generation' | 'compaction'

export type TurnDetailPart =
  | ({ kind: AnswerDetailKind } & AnswerPartRef)
  | { kind: 'workspace-path'; path: string }
  | {
      kind: 'workflow'
      variant?: string
      settings: GenerationSettings
      inputs: ComfyDynamicInputWithCurrent[]
    }

export type TurnResultPart =
  ({ kind: 'prose' | 'artifact' } & AnswerPartRef) | { kind: 'media' } | { kind: 'audio' }

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

/** How a Turn reached its Result, in the order it happened, behind one disclosure. */
export type TurnDetails = { parts: TurnDetailPart[]; summary: TurnSummary; error?: string }
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
type TurnOf<K extends string, Body> = {
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
  live: boolean
}

function isMessageShaped(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const message = value as { id?: unknown; role?: unknown; parts?: unknown }
  return (
    typeof message.id === 'string' &&
    (message.role === 'user' || message.role === 'assistant') &&
    Array.isArray(message.parts)
  )
}

function isTimelineMessage(value: unknown): value is TimelineMessage {
  return isMessageShaped(value)
}

/** Agent and chat turns are stored as the UI messages their engines produced. */
function isUIMessage(value: unknown): value is UIMessage {
  return isMessageShaped(value)
}

function mediaPart(message: TimelineMessage): MediaTurnData | null {
  const part = message.parts.find(
    (candidate): candidate is Extract<TimelinePart, { type: 'data-media' }> =>
      candidate.type === 'data-media',
  )
  return part?.data ?? null
}

function audioPart(message: TimelineMessage): AudioTurnData | null {
  const part = message.parts.find(
    (candidate): candidate is Extract<TimelinePart, { type: 'data-audio' }> =>
      candidate.type === 'data-audio',
  )
  return part?.data ?? null
}

function promptOf(message: TimelineMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}

function agentTagOf(value: unknown): AgentTurnTag | null {
  const tag = (value as { metadata?: { agentTurn?: AgentTurnTag } } | null)?.metadata?.agentTurn
  return tag && typeof tag.harnessSessionId === 'string' ? tag : null
}

/** A Harness Session's live transcript, streamed into the timeline. */
export type LiveAgentTurn = {
  tag: AgentTurnTag
  messages: readonly { id: string }[]
  live: boolean
  queuedMessageId?: string
  notRunMessageId?: string
  canResend?: boolean
}

/**
 * Lays the open Harness Session's live transcript over the saved timeline: a message
 * the Session already holds shows its streaming copy in place, the rest of the
 * running turn follows at the end.
 */
export function withLiveAgentTurn(
  timeline: readonly unknown[],
  tag: AgentTurnTag,
  live: readonly { id: string }[],
): unknown[] {
  if (live.length === 0) return [...timeline]
  const tagged = new Map(
    live.map((message) => {
      const metadata = (message as { metadata?: object }).metadata
      return [message.id, { ...message, metadata: { ...metadata, agentTurn: tag } }]
    }),
  )
  const merged = timeline.map((message) => {
    const id = (message as { id?: unknown } | null)?.id
    const copy = typeof id === 'string' ? tagged.get(id) : undefined
    if (!copy) return message
    tagged.delete(id as string)
    return copy
  })
  return [...merged, ...tagged.values()]
}

function withLiveChatTurn(
  timeline: readonly unknown[],
  live: readonly { id: string }[],
): unknown[] {
  if (live.length === 0) return [...timeline]
  const tagged = new Map(
    live.map((message) => {
      const metadata = (message as { metadata?: object }).metadata
      return [message.id, { ...message, metadata: { ...metadata, chatTurn: true } }]
    }),
  )
  const merged = timeline.map((value) => {
    const saved = asChatTranscriptMessage(value)
    const copy = saved ? tagged.get(saved.id) : undefined
    if (!saved || !copy) return value
    tagged.delete(saved.id)
    return { ...copy, metadata: { ...saved.metadata, ...copy.metadata } }
  })
  return [...merged, ...tagged.values()]
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
  phase?: AudioTurnPhase
}

/** Everything of the open Session still in flight, whichever preset or mode started it. */
export type LiveTurns<M extends PendingMedia, A extends PendingAudio> = {
  /** The Session's chat transcript as the chat store holds it, streaming turn included. */
  chat?: readonly { id: string }[]
  /** Each Harness Session of the Session that is open or running a turn (Task Runs too). */
  agents?: readonly LiveAgentTurn[]
  media?: M | null
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

/**
 * The one main-area timeline of a Session: its saved turns with every live turn laid
 * over them — a live copy replaces its saved message in place, what is not saved yet
 * follows at the end — so what is on screen never depends on the active mode.
 */
export function sessionTimelineItems<M extends PendingMedia, A extends PendingAudio>(
  timeline: readonly unknown[],
  live: LiveTurns<M, A>,
  files: TimelineFiles = {},
): SessionTimelineItem<M, A>[] {
  let merged = withLiveChatTurn(timeline, live.chat ?? [])
  for (const agent of live.agents ?? []) {
    merged = withLiveAgentTurn(merged, agent.tag, agent.messages)
  }
  const turns = timelineTurns(merged, files, live.artifactRuns)
  for (const agent of live.agents ?? []) markLiveAgentTurns(turns, agent)
  const items: SessionTimelineItem<M, A>[] = [...turns]
  const media = live.media
  if (media && !turns.some((turn) => turn.kind === 'media' && turn.media.runId === media.runId)) {
    items.push({
      kind: 'pending-media',
      id: media.runId,
      hint: mediaHint(media),
      details: { parts: [], summary: { kind: 'workflow', preset: media.preset } },
      result: [{ kind: 'media' }],
      prompt: textPrompt(media.prompt ?? '', media.preset, {
        inputImageUrl: media.inputImageUrl || undefined,
      }),
      footer: noFooter(),
      pending: media,
      artifacts: pendingMediaArtifacts(media, live.artifactRuns, files.deletedUrls ?? []),
    })
  }
  if (live.audio) {
    const audio = live.audio
    items.push({
      kind: 'pending-audio',
      id: 'pending-audio',
      hint: audioHint(audio),
      details: audioDetails(audio),
      result: [{ kind: 'audio' }],
      prompt: textPrompt(audio.prompt ?? '', audio.preset),
      footer: noFooter(),
      pending: audio,
      audioArtifacts: pendingAudioArtifacts('pending-audio', audio.kind, audio.phase),
    })
  }
  const last = items.at(-1)
  if (last?.kind === 'chat') last.footer = chatAnswerFooter(last.answers, true)
  if (last?.kind === 'media') {
    const rerun = mediaRerun(last.media, last.prompt.text)
    if (rerun) last.footer = { actions: ['regenerate'], text: '', rerun }
  }
  return items
}

const IMAGE_INPUT_TYPES = new Set(['image', 'inpaintMask', 'outpaintCanvas'])

/** Nothing to rerun when the run recorded no settings or lost an input image it needed. */
export function mediaRerun(media: MediaTurnData, promptText: string): MediaRerun | null {
  const item = media.items[0]
  if (!item?.settings) return null
  const settings = item.settings
  let fallbackSource = item.sourceImageUrl
  let inputImageUrl: string | undefined
  const inputs: Record<string, unknown> = {}
  for (const input of item.dynamicSettings ?? []) {
    let current: unknown = input.current
    if (IMAGE_INPUT_TYPES.has(input.type) && !current && input.optional !== true) {
      if (input.type !== 'image' || !fallbackSource) return null
      current = fallbackSource
      fallbackSource = undefined
    }
    if (input.type === 'image' && current && !inputImageUrl) inputImageUrl = String(current)
    inputs[`${input.nodeTitle}.${input.nodeInput}`] = current
  }
  const [resolutionWidth, resolutionHeight] =
    typeof settings.resolution === 'string' ? settings.resolution.split('x').map(Number) : []
  const params = Object.fromEntries(
    Object.entries({
      seed: -1,
      inferenceSteps: settings.inferenceSteps,
      width: settings.width ?? resolutionWidth,
      height: settings.height ?? resolutionHeight,
      batchSize: settings.batchSize,
    }).filter(([, value]) => typeof value === 'number' && !Number.isNaN(value)),
  ) as MediaRerun['params']
  return {
    mode: media.mode,
    workflow: media.preset,
    ...(media.variant ? { variant: media.variant } : {}),
    prompt: settings.prompt ?? promptText,
    ...(settings.negativePrompt !== undefined ? { negativePrompt: settings.negativePrompt } : {}),
    params,
    inputs,
    ...(media.mode !== 'imageGen' && inputImageUrl ? { inputImageUrl } : {}),
  }
}

function noFooter(): TurnFooter {
  return { actions: [], text: '' }
}

function textPrompt(
  text: string,
  preset: string,
  extra: Omit<TurnPrompt, 'text' | 'placeholder'> = {},
): TurnPrompt {
  const defined = Object.entries(extra).filter(([, value]) => value !== undefined)
  return { text, ...(text ? {} : { placeholder: preset }), ...Object.fromEntries(defined) }
}

type FilePart = { type: string; mediaType?: string; url?: string; filename?: string }

export function messagePrompt(message: UIMessage): TurnPrompt {
  const files = (message.parts as FilePart[]).filter((part) => part.type === 'file' && part.url)
  const image = files.findLast((part) => part.mediaType?.startsWith('image/'))?.url
  const audio = files
    .filter((part) => part.mediaType?.startsWith('audio/'))
    .map((part) => ({ url: part.url!, ...(part.filename ? { name: part.filename } : {}) }))
  const origin = (message.metadata as { origin?: ChannelKind } | undefined)?.origin
  return {
    text: messageText(message),
    ...(image ? { inputImageUrl: image } : {}),
    ...(audio.length ? { audio } : {}),
    ...(origin ? { origin } : {}),
  }
}

/** Panel Image Edit and Video runs take their source through the workflow's image input. */
function mediaInputImage(media: MediaTurnData): string | undefined {
  if (media.mode === 'imageGen') return undefined
  const item = media.items[0]
  const input = item?.dynamicSettings?.find(
    (setting) => setting.type === 'image' && setting.current,
  )
  const url = input ? String(input.current) : item?.sourceImageUrl
  return url || undefined
}

function answersText(answers: UIMessage[]): string {
  return answers.map(messageText).filter(Boolean).join('\n\n')
}

function agentFooter(answers: UIMessage[]): TurnFooter {
  const text = answersText(answers)
  return { actions: text ? ['copy'] : [], text }
}

/** Regenerate redoes only the newest answer of a conversation, so only `last` offers it. */
export function chatAnswerFooter(answers: UIMessage[], last = false): TurnFooter {
  const answer = answers.at(-1)
  if (!answer || !answers.some(messageHasVisibleContent)) return noFooter()
  const text = answersText(answers)
  const actions: TurnFooterAction[] = [
    ...(text ? (['copy', 'speak'] as const) : []),
    ...(last ? (['regenerate'] as const) : []),
    'delete',
  ]
  const metadata = answer.metadata as AipgMetadata | undefined
  const metrics = metadata?.timings
    ? {
        timings: metadata.timings,
        ...(metadata.compute ? { compute: metadata.compute } : {}),
        ...(metadata.energy ? { energy: metadata.energy } : {}),
      }
    : undefined
  return { actions, text, messageId: answer.id, ...(metrics ? { metrics } : {}) }
}

function audioFooter(audio: AudioTurnData): TurnFooter {
  const text = audio.kind === 'stt' ? (audio.transcript ?? '') : ''
  return { actions: text ? ['copy'] : [], text }
}

/** A model id as people know it: a GGUF file's name without its folder and extension. */
export function modelDisplayName(model: string): string {
  return model.endsWith('.gguf')
    ? (model.split('/').at(-1)?.slice(0, -'.gguf'.length) ?? model)
    : model
}

function metadataOf(message: UIMessage | undefined): { model?: unknown; preset?: unknown } {
  return (message?.metadata as { model?: unknown; preset?: unknown } | undefined) ?? {}
}

function stampedString(messages: (UIMessage | undefined)[], key: 'model' | 'preset') {
  for (const message of messages) {
    const value = metadataOf(message)[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function chatHint(prompt: UIMessage | undefined, answers: UIMessage[]): TurnHint {
  const model = stampedString([...answers, prompt], 'model')
  const preset = stampedString([...answers, prompt], 'preset')
  const detail = model ? modelDisplayName(model) : undefined
  if (preset) return { kind: 'chat', icon: 'chat', preset, ...(detail ? { detail } : {}) }
  return { kind: 'chat', icon: 'chat', preset: detail ?? 'Chat' }
}

function agentHint(presetName: string, answers: UIMessage[]): TurnHint {
  const model = stampedString(answers, 'model')
  return {
    kind: 'agent',
    icon: 'agent',
    preset: presetName,
    ...(model ? { detail: modelDisplayName(model) } : {}),
  }
}

function mediaHint(media: PendingMedia & { variant?: string }): TurnHint {
  return {
    kind: 'workflow',
    icon: media.mode === 'video' ? 'video' : 'image',
    preset: media.preset,
    ...(media.variant ? { detail: media.variant } : {}),
  }
}

function audioHint(audio: PendingAudio & { engine?: string }): TurnHint {
  return {
    kind: 'speech',
    icon: audio.kind,
    preset: audio.preset,
    ...(audio.engine ? { detail: audio.engine } : {}),
  }
}

/** Chat and agent answers arrive after their Turn is opened, so hint, parts and footer are read last. */
function withAnswers(turns: TimelineTurn[], prompts: Map<string, UIMessage>): TimelineTurn[] {
  for (const turn of turns) {
    if (turn.kind === 'chat') {
      turn.hint = chatHint(prompts.get(turn.id), turn.answers)
      turn.footer = chatAnswerFooter(turn.answers)
    }
    if (turn.kind === 'agent') {
      turn.hint = agentHint(turn.presetName, turn.answers)
      turn.footer = agentFooter(turn.answers)
    }
    if (turn.kind === 'chat' || turn.kind === 'agent') {
      Object.assign(turn, answerSections(turn.kind, turn.answers))
    }
  }
  return turns
}

const EMPTY_DETAILS: TurnDetails = { parts: [], summary: { kind: 'activity' } }

type PartShape = { type?: unknown; state?: unknown; output?: unknown }

function shapeOf(part: unknown): PartShape {
  return typeof part === 'object' && part !== null ? (part as PartShape) : {}
}

/** Chat tools whose output is something the user asked for rather than a step toward it. */
const CHAT_RESULT_TOOL_NAMES = new Set(['visualizeObjectDetections', 'synthesizeTextToSpeech'])

type PartPlacement = { details?: AnswerDetailKind; result?: boolean }

function chatPlacement(part: unknown): PartPlacement {
  const name = toolPartNameOf(part)
  if (name === undefined) return {}
  if (isChatMediaToolPart(part)) return { details: 'generation', result: true }
  if (CHAT_RESULT_TOOL_NAMES.has(name)) return { result: true }
  return { details: 'tool' }
}

function agentPlacement(part: unknown): PartPlacement {
  if (toolPartNameOf(part) === undefined) return {}
  if (compactionOutputOf(part)) return { details: 'compaction' }
  if (mediaToolNameOf(part)) return { details: 'generation', result: true }
  if (ttsToolArtifacts(part, []).length > 0) return { details: 'tool', result: true }
  return { details: 'tool' }
}

function placementOf(engine: 'chat' | 'agent', part: unknown): PartPlacement {
  if (isReasoningPart(part)) return { details: 'reasoning' }
  if (shapeOf(part).type === 'text') return { result: true }
  return engine === 'chat' ? chatPlacement(part) : agentPlacement(part)
}

function artifactKindsOf(engine: 'chat' | 'agent', part: unknown): ArtifactKind[] {
  const { state, output } = shapeOf(part)
  if (state !== 'output-available') return []
  if (engine === 'agent') {
    const media = generatedMediaOf(part)
    return [
      ...(media?.items ?? []).map((item) => item.type),
      ...(media?.audio ? ['audio' as const] : []),
    ]
  }
  const record = (output ?? {}) as {
    images?: unknown
    savedFilePath?: unknown
    annotatedImageUrl?: unknown
  }
  if (isChatMediaToolPart(part)) {
    return (Array.isArray(record.images) ? record.images : []).flatMap((item) => {
      const type = (item as { type?: unknown } | null)?.type
      return type === 'image' || type === 'video' || type === 'model3d' ? [type] : []
    })
  }
  const name = toolPartNameOf(part)
  if (name === 'synthesizeTextToSpeech' && record.savedFilePath) return ['audio']
  if (name === 'visualizeObjectDetections' && record.annotatedImageUrl) return ['image']
  return []
}

function workspacePathsOf(part: unknown): string[] {
  const media = generatedMediaOf(part)
  if (!media) return []
  return [...media.items, ...(media.audio ? [media.audio] : [])].flatMap((target) =>
    typeof target.workspacePath === 'string' && target.workspacePath ? [target.workspacePath] : [],
  )
}

/** Splits a chat or agent Turn's answers into Turn Details and the Result, each in order. */
function answerSections(
  engine: 'chat' | 'agent',
  answers: UIMessage[],
): { details: TurnDetails; result: TurnResultPart[] } {
  const parts: TurnDetailPart[] = []
  const result: TurnResultPart[] = []
  const allParts: unknown[] = []
  let tools = 0
  const artifacts: Partial<Record<ArtifactKind, number>> = {}
  for (const answer of answers) {
    answer.parts.forEach((part, index) => {
      allParts.push(part)
      const ref = { messageId: answer.id, index }
      const placement = placementOf(engine, part)
      if (placement.details) {
        parts.push({ kind: placement.details, ...ref })
        if (engine === 'agent') {
          for (const path of workspacePathsOf(part)) parts.push({ kind: 'workspace-path', path })
        }
      }
      if (placement.result) {
        result.push({ kind: shapeOf(part).type === 'text' ? 'prose' : 'artifact', ...ref })
      }
      if (toolPartNameOf(part) !== undefined && !compactionOutputOf(part)) tools++
      for (const kind of artifactKindsOf(engine, part)) artifacts[kind] = (artifacts[kind] ?? 0) + 1
    })
  }
  const summary: TurnSummary = { kind: 'activity' }
  if (allParts.some(isReasoningPart)) summary.reasoningMs = reasoningElapsedMsFromParts(allParts)
  if (tools > 0) summary.tools = tools
  if (Object.keys(artifacts).length > 0) summary.artifacts = artifacts
  return { details: { parts, summary }, result }
}

function settingsWithoutPrompt(settings: GenerationSettings | undefined): GenerationSettings {
  const { preset: _preset, variant: _variant, prompt: _prompt, ...rest } = settings ?? {}
  return Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined && value !== ''),
  ) as GenerationSettings
}

function mediaDetails(media: MediaTurnData): TurnDetails {
  const first = media.items[0]
  const settings = first?.settings
  const parts: TurnDetailPart[] =
    first || media.variant
      ? [
          {
            kind: 'workflow',
            ...(media.variant ? { variant: media.variant } : {}),
            settings: settingsWithoutPrompt(settings),
            inputs: (first?.dynamicSettings ?? []).filter((input) => input.current !== ''),
          },
        ]
      : []
  const summary: TurnSummary = { kind: 'workflow', preset: media.preset }
  if (settings?.width && settings.height) {
    summary.width = settings.width
    summary.height = settings.height
  }
  if (typeof settings?.seed === 'number' && settings.seed >= 0) summary.seed = settings.seed
  if (media.durationMs !== undefined) summary.durationMs = media.durationMs
  return {
    parts,
    summary,
    ...(media.status === 'failed' && media.error ? { error: media.error } : {}),
  }
}

function audioDetails(audio: PendingAudio & Partial<AudioTurnData>): TurnDetails {
  return {
    parts: [],
    summary: {
      kind: 'speech',
      preset: audio.preset,
      ...(audio.engine ? { engine: audio.engine } : {}),
    },
    ...(audio.status === 'failed' && audio.error ? { error: audio.error } : {}),
  }
}

/** Words for the Turn Details summary; `{count}`, `{duration}` and `{seed}` are filled in. */
export type TurnSummaryLabels = {
  reasoned: string
  reasonedUntimed: string
  tool: string
  tools: string
  image: string
  images: string
  video: string
  videos: string
  model3d: string
  models3d: string
  audio: string
  audios: string
  seed: string
}

export function formatTurnDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds - minutes * 60}s`
}

const ARTIFACT_LABELS: Record<ArtifactKind, [keyof TurnSummaryLabels, keyof TurnSummaryLabels]> = {
  image: ['image', 'images'],
  video: ['video', 'videos'],
  model3d: ['model3d', 'models3d'],
  audio: ['audio', 'audios'],
}

function counted(count: number, [one, many]: [string, string]): string {
  return count === 1 ? one : many.replace('{count}', String(count))
}

/** The collapsed header's one line: the parts present, joined by " · ". */
export function turnDetailsSummaryText(summary: TurnSummary, labels: TurnSummaryLabels): string {
  const clauses: string[] = []
  if (summary.kind === 'activity') {
    if (summary.reasoningMs !== undefined) {
      clauses.push(
        summary.reasoningMs > 0
          ? labels.reasoned.replace('{duration}', formatTurnDuration(summary.reasoningMs))
          : labels.reasonedUntimed,
      )
    }
    if (summary.tools) clauses.push(counted(summary.tools, [labels.tool, labels.tools]))
    for (const [kind, keys] of Object.entries(ARTIFACT_LABELS) as [
      ArtifactKind,
      [keyof TurnSummaryLabels, keyof TurnSummaryLabels],
    ][]) {
      const count = summary.artifacts?.[kind]
      if (count) clauses.push(counted(count, [labels[keys[0]], labels[keys[1]]]))
    }
  } else if (summary.kind === 'workflow') {
    clauses.push(summary.preset)
    if (summary.width && summary.height) clauses.push(`${summary.width}×${summary.height}`)
    if (summary.seed !== undefined)
      clauses.push(labels.seed.replace('{seed}', String(summary.seed)))
    if (summary.durationMs !== undefined) clauses.push(formatTurnDuration(summary.durationMs))
  } else {
    clauses.push(summary.preset)
    if (summary.engine) clauses.push(summary.engine)
  }
  return clauses.join(' · ')
}

function markLiveAgentTurns(entries: TimelineEntry[], agent: LiveAgentTurn): void {
  const id = agent.tag.harnessSessionId
  const turns = entries.flatMap((entry) => {
    if (entry.kind === 'task-run') return entry.harnessSessionId === id ? entry.turns : []
    return entry.kind === 'agent' && entry.harnessSessionId === id ? [entry] : []
  })
  const last = turns.at(-1)
  for (const turn of turns) {
    turn.streaming = agent.live && turn === last
    turn.queued = !!turn.prompt && turn.id === agent.queuedMessageId
    turn.notRun = !!turn.prompt && turn.id === agent.notRunMessageId
    turn.canResend = !!agent.canResend && turn.notRun && turn === last
  }
  const run = entries.find((entry) => entry.kind === 'task-run' && entry.harnessSessionId === id)
  if (run?.kind === 'task-run') run.live = agent.live
}

function pendingMediaArtifacts(
  media: PendingMedia,
  artifactRuns: ArtifactRunsState | undefined,
  deletedUrls: readonly string[],
): TurnArtifact[] {
  const run = artifactRuns?.runs[media.runId]
  if (run) return runArtifacts([run], deletedUrls)
  return placeholderArtifacts(media.runId, media.mode, media.size, media.batchSize ?? 1)
}

function withArtifacts(
  turns: TimelineTurn[],
  deletedUrls: readonly string[],
  artifactRuns: ArtifactRunsState | undefined,
): TimelineTurn[] {
  for (const turn of turns) {
    if (turn.kind === 'chat' || turn.kind === 'agent') {
      turn.artifacts = turn.answers.flatMap((answer) =>
        answer.parts.flatMap((part) => toolCallArtifacts(part, artifactRuns, deletedUrls)),
      )
      turn.audioArtifacts = turn.answers.flatMap((answer) =>
        answer.parts.flatMap((part) => ttsToolArtifacts(part, deletedUrls)),
      )
    }
    if (turn.kind === 'media') turn.artifacts = turnArtifacts(turn.media.items, deletedUrls)
    if (turn.kind === 'audio')
      turn.audioArtifacts = audioTurnArtifacts(turn.id, turn.audio, deletedUrls)
  }
  return turns
}

/** Folds each Task Run's consecutive Turns into its container. */
function withTaskRuns(turns: TimelineTurn[]): TimelineEntry[] {
  const entries: TimelineEntry[] = []
  for (const turn of turns) {
    if (turn.kind !== 'agent' || !turn.taskRun) {
      entries.push(turn)
      continue
    }
    const last = entries.at(-1)
    if (last?.kind === 'task-run' && last.harnessSessionId === turn.harnessSessionId) {
      last.turns.push(turn)
      continue
    }
    entries.push({
      kind: 'task-run',
      id: `task-run-${turn.id}`,
      harnessSessionId: turn.harnessSessionId,
      taskRun: turn.taskRun,
      turns: [turn],
      live: false,
    })
  }
  return entries
}

/**
 * One Turn per prompt: a chat or agent prompt with the answers that followed it, a
 * ComfyUI or audio prompt with its result card; a Task Run holds its Turns. Anything
 * else stays a plain message.
 */
export function timelineTurns(
  timeline: readonly unknown[],
  files: TimelineFiles = {},
  artifactRuns?: ArtifactRunsState,
): TimelineEntry[] {
  const messages = timeline.filter(isTimelineMessage)
  const turns: TimelineTurn[] = []
  const prompts = new Map<string, UIMessage>()
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const tag = agentTagOf(message)
    if (tag && isUIMessage(message)) {
      const last = turns.at(-1)
      if (
        message.role === 'assistant' &&
        last?.kind === 'agent' &&
        last.harnessSessionId === tag.harnessSessionId
      ) {
        last.answers.push(message)
      } else {
        if (message.role === 'user') prompts.set(message.id, message)
        turns.push({
          kind: 'agent',
          id: message.id,
          hint: agentHint(tag.presetName, []),
          details: EMPTY_DETAILS,
          result: [],
          footer: noFooter(),
          presetName: tag.presetName,
          harnessSessionId: tag.harnessSessionId,
          artifacts: [],
          audioArtifacts: [],
          ...(message.role === 'user'
            ? { prompt: messagePrompt(message), answers: [] }
            : { answers: [message] }),
          ...(tag.taskRun ? { taskRun: tag.taskRun } : {}),
        })
      }
      continue
    }
    if (asChatTranscriptMessage(message) && isUIMessage(message)) {
      const last = turns.at(-1)
      if (message.role === 'assistant' && last?.kind === 'chat') {
        last.answers.push(message)
        continue
      }
      const prompted = message.role === 'user'
      if (prompted) prompts.set(message.id, message)
      turns.push({
        kind: 'chat',
        id: message.id,
        hint: chatHint(undefined, []),
        details: EMPTY_DETAILS,
        result: [],
        footer: noFooter(),
        artifacts: [],
        audioArtifacts: [],
        ...(prompted ? { prompt: messagePrompt(message), answers: [] } : { answers: [message] }),
      })
      continue
    }
    const next = messages[i + 1]
    const answer = message.role === 'user' && next?.role === 'assistant' ? next : null
    const media = answer ? mediaPart(answer) : null
    const audio = answer && !media ? audioPart(answer) : null
    if (answer && audio) {
      turns.push({
        kind: 'audio',
        id: answer.id,
        hint: audioHint(audio),
        details: audioDetails(audio),
        result: [{ kind: 'audio' }],
        footer: audioFooter(audio),
        prompt: textPrompt(promptOf(message), audio.preset, {
          audio: audio.kind === 'stt' && audio.audioUrl ? [{ url: audio.audioUrl }] : undefined,
        }),
        createdAt: message.createdAt,
        audio,
        audioArtifacts: [],
      })
      i++
      continue
    }
    if (next && media) {
      turns.push({
        kind: 'media',
        id: next.id,
        hint: mediaHint(media),
        details: mediaDetails(media),
        result: [{ kind: 'media' }],
        footer: noFooter(),
        prompt: textPrompt(promptOf(message), media.preset, {
          inputImageUrl: mediaInputImage(media),
        }),
        createdAt: message.createdAt,
        media,
        artifacts: [],
      })
      i++
      continue
    }
    turns.push({ kind: 'message', id: message.id, message })
  }
  return withTaskRuns(
    withArtifacts(withAnswers(turns, prompts), files.deletedUrls ?? [], artifactRuns),
  )
}
