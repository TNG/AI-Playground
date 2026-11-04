import type { UIMessage } from 'ai'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import {
  compactionOutputOf,
  generatedMediaOf,
  isReasoningPart,
  mediaToolNameOf,
  objectInputOf,
  toolActionLabel,
  toolPartNameOf,
} from '@/lib/agentTranscript'
import { isTerminalPhase, type ArtifactRunsState } from '@/lib/artifactRunProjection'
import { audioTurnArtifacts, pendingAudioArtifacts, ttsToolArtifacts } from '@/lib/audioArtifacts'
import { messageText } from '@/lib/chatMessageText'
import { isChatMediaToolPart } from '@/lib/chatToolParts'
import { mediaRerun } from '@/lib/mediaRerun'
import { reasoningElapsedMsFromParts } from '@/lib/reasoningTimings'
import { asChatTranscriptMessage } from '@/lib/sessionChat'
import {
  generationFailure,
  oneLine,
  placeholderArtifacts,
  runArtifacts,
  runFailure,
  toolCallArtifacts,
  toolCallFailureRecord,
  toolCallResultFailure,
  turnArtifacts,
  type GenerationFailure,
  type TurnArtifact,
} from '@/lib/turnArtifacts'
import { agentFooter, audioFooter, chatAnswerFooter, noFooter } from '@/lib/turnFooter'
import { modelDisplayName } from '@/lib/turnText'
import type {
  AnswerDetailKind,
  ArtifactKind,
  LiveAgentTurn,
  LiveChatStatus,
  LiveTurns,
  MediaStepStatus,
  PendingAudio,
  PendingMedia,
  SessionTimelineItem,
  TimelineEntry,
  TimelineFiles,
  TimelineTurn,
  TurnDetailPart,
  TurnDetails,
  TurnHint,
  TurnLiveStatus,
  TurnPrompt,
  TurnResultPart,
  TurnSummary,
} from '@/lib/turnTypes'
import type { GenerationSettings } from '@/types/mediaItem'
import type {
  AgentTurnTag,
  AudioTurnData,
  MediaTurnData,
  TimelineMessage,
  TimelinePart,
} from '@/types/sessionTimeline'

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
  const mediaSteps = live.mediaSteps ?? {}
  for (const agent of live.agents ?? []) markLiveAgentTurns(turns, agent, mediaSteps)
  markLiveChatTurn(turns, live.chatStatus, mediaSteps)
  const items: SessionTimelineItem<M, A>[] = [...turns]
  const media = live.media
  if (media && !turns.some((turn) => turn.kind === 'media' && turn.media.runId === media.runId)) {
    const run = live.artifactRuns?.runs[media.runId]
    const failure = runFailure(run)
    items.push({
      kind: 'pending-media',
      id: media.runId,
      hint: mediaHint(media),
      details: {
        parts: [],
        summary: { kind: 'workflow', preset: media.preset },
        ...(run && isTerminalPhase(run.phase)
          ? {}
          : {
              live: {
                kind: 'artifact' as const,
                phase: run?.phase ?? 'queued',
                ...(run?.progress ? { progress: run.progress } : {}),
              },
            }),
        ...(run?.phase === 'failed' && run.error ? { error: run.error } : {}),
      },
      result: [{ kind: 'media' }, ...(failure ? [{ kind: 'failure' as const, ...failure }] : [])],
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
      details: {
        ...audioDetails(audio),
        live: { kind: 'audio', phase: audio.phase ?? 'generating' },
      },
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
  const errors: string[] = []
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
        const failure = toolCallResultFailure(part)
        if (failure) result.push({ kind: 'failure', ...ref, ...failure })
        else result.push({ kind: shapeOf(part).type === 'text' ? 'prose' : 'artifact', ...ref })
      }
      const error = toolCallFailureRecord(part)?.error
      if (error) errors.push(error)
      if (toolPartNameOf(part) !== undefined && !compactionOutputOf(part)) tools++
      for (const kind of artifactKindsOf(engine, part)) artifacts[kind] = (artifacts[kind] ?? 0) + 1
    })
  }
  const summary: TurnSummary = { kind: 'activity' }
  if (allParts.some(isReasoningPart)) summary.reasoningMs = reasoningElapsedMsFromParts(allParts)
  if (tools > 0) summary.tools = tools
  if (Object.keys(artifacts).length > 0) summary.artifacts = artifacts
  const error = joinErrors(errors)
  return { details: { parts, summary, ...(error ? { error } : {}) }, result }
}

function joinErrors(errors: (string | undefined)[]): string | undefined {
  return [...new Set(errors.filter(Boolean))].join('\n\n') || undefined
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

/** What the newest part of a running answer says the Turn is doing; null between parts. */
function partsLiveStatus(
  engine: 'chat' | 'agent',
  answers: UIMessage[],
  mediaSteps: Readonly<Record<string, MediaStepStatus>>,
): TurnLiveStatus | null {
  const part = answers.at(-1)?.parts.at(-1)
  if (!part) return null
  const shape = shapeOf(part) as PartShape & { toolCallId?: unknown }
  if (isReasoningPart(part)) return shape.state === 'done' ? null : { kind: 'reasoning' }
  if (shape.type === 'text') return shape.state === 'streaming' ? { kind: 'writing' } : null
  const name = toolPartNameOf(part)
  if (!name || (shape.state !== 'input-streaming' && shape.state !== 'input-available')) {
    return null
  }
  const step = typeof shape.toolCallId === 'string' ? mediaSteps[shape.toolCallId] : undefined
  const label =
    step?.label ?? (engine === 'agent' ? toolActionLabel(name, objectInputOf(part)) : undefined)
  return {
    kind: 'tool',
    name,
    ...(label ? { label } : {}),
    ...(step?.progress !== undefined ? { progress: step.progress } : {}),
  }
}

function markLiveChatTurn(
  entries: TimelineEntry[],
  status: LiveChatStatus | undefined,
  mediaSteps: Readonly<Record<string, MediaStepStatus>>,
): void {
  if (!status?.running) return
  const turn = entries.findLast((entry) => entry.kind === 'chat')
  if (turn?.kind !== 'chat') return
  const fromParts = partsLiveStatus('chat', turn.answers, mediaSteps)
  const live: TurnLiveStatus = (fromParts?.kind === 'tool' && fromParts.label ? fromParts : null) ??
    (status.activity ? { kind: 'activity', ...status.activity } : null) ??
    fromParts ?? { kind: 'working' }
  turn.details = { ...turn.details, live }
  if (status.questionKey) turn.questionKey = status.questionKey
}

function markLiveAgentTurns(
  entries: TimelineEntry[],
  agent: LiveAgentTurn,
  mediaSteps: Readonly<Record<string, MediaStepStatus>>,
): void {
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
  if (last) {
    const live: TurnLiveStatus | null = !agent.live
      ? null
      : last.queued
        ? { kind: 'queued' }
        : (partsLiveStatus('agent', last.answers, mediaSteps) ?? { kind: 'working' })
    const error = joinErrors([last.details.error, agent.error])
    const errorLine = oneLine(agent.error)
    last.details = {
      ...last.details,
      ...(live ? { live } : {}),
      ...(error ? { error } : {}),
      ...(errorLine ? { errorLine } : {}),
    }
    if (agent.open) last.questionKey = id
    if (agent.heldAnswer) last.heldAnswer = agent.heldAnswer
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
    if (turn.kind === 'media') {
      turn.artifacts = turnArtifacts(turn.media.items, deletedUrls, turn.media.error)
      const failure = mediaFailure(turn.media, turn.artifacts)
      if (failure) turn.result = [...turn.result, { kind: 'failure', ...failure }]
    }
    if (turn.kind === 'audio')
      turn.audioArtifacts = audioTurnArtifacts(turn.id, turn.audio, deletedUrls)
  }
  return turns
}

/** A ComfyUI run that ended with no card saying so says why in one line. */
function mediaFailure(media: MediaTurnData, artifacts: TurnArtifact[]): GenerationFailure | null {
  if (media.status === 'completed') return null
  if (artifacts.some((artifact) => artifact.state === 'failed' || artifact.state === 'cancelled')) {
    return null
  }
  return generationFailure({ state: media.status, error: media.error })
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
      resultTurns: [],
      live: false,
    })
  }
  for (const entry of entries) {
    if (entry.kind === 'task-run') entry.resultTurns = entry.turns.filter((t) => t.result.length)
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
