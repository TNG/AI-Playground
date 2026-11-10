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
import type { LatestTurn } from '@/lib/agentComposer'
import { modelDisplayName } from '@/lib/turnText'
import type {
  AgentRunIdentity,
  AgentTurn,
  AnswerDetailKind,
  AnswerPartRef,
  ArtifactKind,
  LiveAgentTurn,
  LiveChatStatus,
  LiveTurns,
  MediaStepStatus,
  PendingAudio,
  PendingMedia,
  SessionTimelineItem,
  TimelineFiles,
  TimelineTurn,
  TurnDetailPart,
  TurnDetails,
  TurnHint,
  TurnLiveStatus,
  TurnPrompt,
  TurnResultPart,
  TurnSummary,
  RunProgress,
} from '@/lib/turnTypes'
import type { GenerationSettings } from '@/types/mediaItem'
import type {
  AgentTurnTag,
  AudioTurnData,
  MediaTurnData,
  AgentRunTag,
  PromptRunTag,
  TimelineMessage,
  TimelinePart,
} from '@/types/sessionTimeline'

/** One Step of an Agent Run: the prompt the run sent and the answers to it. */
type RunStep = { prompt?: UIMessage; answers: UIMessage[] }

type AgentRun = { key: string; turn: AgentTurn; steps: RunStep[]; end?: AgentRunTag['end'] }

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

/** The Agent a Follow-up prompt was sent to, by name; undefined for any other message. */
export function followUpAgentName(message: unknown): string | undefined {
  const { role, metadata } = message as {
    role?: unknown
    metadata?: { followUp?: { agentName?: unknown } }
  }
  const name = metadata?.followUp?.agentName
  return role === 'user' && typeof name === 'string' ? name : undefined
}

/** An Agent Run fills its own Harness Session; Run steps marks each Step prompt it sends. */
function runTagOf(tag: AgentTurnTag, message: UIMessage): { key: string; run: AgentRunTag } | null {
  if (tag.taskRun) return { key: tag.harnessSessionId, run: tag.taskRun }
  const marked = (message.metadata as { agentRun?: PromptRunTag } | undefined)?.agentRun
  return message.role === 'user' && typeof marked?.runId === 'string'
    ? { key: marked.runId, run: marked }
    : null
}

/** A live copy replaces its saved message in place; unsaved live messages follow at the end. */
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

export function sessionTimelineItems<M extends PendingMedia, A extends PendingAudio>(
  timeline: readonly unknown[],
  live: LiveTurns<M, A>,
  files: TimelineFiles = {},
): SessionTimelineItem<M, A>[] {
  let merged = withLiveChatTurn(timeline, live.chat ?? [])
  for (const agent of live.agents ?? []) {
    merged = withLiveAgentTurn(merged, agent.tag, agent.messages)
  }
  const inFlight = new Map(Object.entries(live.agentRunsInFlight ?? {}))
  const turns = timelineTurns(merged, files, live.artifactRuns, inFlight)
  const mediaSteps = live.mediaSteps ?? {}
  for (const agent of live.agents ?? []) markLiveAgentTurns(turns, agent, mediaSteps)
  markRunsInFlight(turns, inFlight)
  for (const turn of turns) if (turn.kind === 'agent' && turn.streaming) turn.footer = noFooter()
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

/** Answers arrive after their Turn opens, so hint, sections and footer are read last. */
function withAnswers(
  turns: TimelineTurn[],
  prompts: Map<string, UIMessage>,
  runs: Map<string, AgentRun>,
  inFlight: ReadonlyMap<string, RunProgress>,
): TimelineTurn[] {
  for (const turn of turns) {
    if (turn.kind === 'chat') {
      turn.hint = chatHint(prompts.get(turn.id), turn.answers)
      turn.footer = chatAnswerFooter(turn.answers)
    }
    if (turn.kind === 'agent') {
      turn.hint = agentHint(turn.prompt?.agentRun?.name ?? turn.presetName, turn.answers)
    }
    const run = turn.kind === 'agent' && turn.runKey ? runs.get(turn.runKey) : undefined
    if (run) Object.assign(turn, runSections(run, inFlight.has(run.key)))
    else if (turn.kind === 'chat' || turn.kind === 'agent') {
      Object.assign(turn, answerSections(turn.kind, turn.answers))
    }
    if (turn.kind === 'agent') turn.footer = agentFooter(resultText(turn))
  }
  return turns
}

function resultText(turn: AgentTurn): string {
  const answers = new Map(turn.answers.map((answer) => [answer.id, answer]))
  return turn.result
    .flatMap((part) => {
      if (part.kind !== 'prose') return []
      const text = (answers.get(part.messageId)?.parts[part.index] as { text?: unknown })?.text
      return typeof text === 'string' && text.trim() ? [text.trim()] : []
    })
    .join('\n\n')
}

/** An Agent Run's answer is the text its last Step wrote after its last tool call. */
function finalProse(step: RunStep | undefined): Set<string> {
  const refs = (step?.answers ?? []).flatMap((answer) =>
    answer.parts.map((part, index) => ({ part, key: `${answer.id}:${index}` })),
  )
  const lastTool = refs.findLastIndex(({ part }) => toolPartNameOf(part) !== undefined)
  return new Set(
    refs
      .slice(lastTool + 1)
      .flatMap(({ part, key }) => (shapeOf(part).type === 'text' ? [key] : [])),
  )
}

/** Until the run ends, its newest text is a Step's progress, not its answer. */
function runSections(
  run: AgentRun,
  inFlight: boolean,
): { details: TurnDetails; result: TurnResultPart[] } {
  const final = inFlight ? new Set<string>() : finalProse(run.steps.at(-1))
  const prose = (ref: AnswerPartRef) => final.has(`${ref.messageId}:${ref.index}`)
  const whole = answerSections(
    'agent',
    run.steps.flatMap((step) => step.answers),
  )
  const parts: TurnDetailPart[] = []
  const result: TurnResultPart[] = []
  run.steps.forEach((step, index) => {
    if (step.prompt) {
      parts.push({ kind: 'step-prompt', step: index + 1, prompt: messagePrompt(step.prompt) })
    }
    const sections = answerSections('agent', step.answers, prose)
    parts.push(...sections.details.parts)
    result.push(...sections.result)
  })
  const end = run.end
  if (end) {
    const state = end.kind === 'failed' ? 'failed' : 'cancelled'
    result.push({ kind: 'failure', ...generationFailure({ state, error: end.message }) })
  }
  const summary = { ...whole.details.summary, steps: run.steps.length }
  return { details: { ...whole.details, parts, summary }, result }
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

function answerSections(
  engine: 'chat' | 'agent',
  answers: UIMessage[],
  proseInResult: (ref: AnswerPartRef) => boolean = () => true,
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
      if (shapeOf(part).type === 'text' && !proseInResult(ref)) {
        parts.push({ kind: 'prose', ...ref })
        return
      }
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
  entries: TimelineTurn[],
  status: LiveChatStatus | undefined,
  mediaSteps: Readonly<Record<string, MediaStepStatus>>,
): void {
  const turn = entries.findLast((entry) => entry.kind === 'chat')
  if (turn?.kind !== 'chat' || !status) return
  if (status.error && !status.running && turn.result.length === 0) {
    turn.result = [
      { kind: 'failure', ...generationFailure({ state: 'failed', error: status.error }) },
    ]
    turn.details = { ...turn.details, error: joinErrors([turn.details.error, status.error]) }
  }
  if (!status.running) return
  const fromParts = partsLiveStatus('chat', turn.answers, mediaSteps)
  const live: TurnLiveStatus = (fromParts?.kind === 'tool' && fromParts.label ? fromParts : null) ??
    (status.activity ? { kind: 'activity', ...status.activity } : null) ??
    fromParts ?? { kind: 'working' }
  turn.details = { ...turn.details, live }
  if (status.questionKey) turn.questionKey = status.questionKey
}

function markLiveAgentTurns(
  entries: TimelineTurn[],
  agent: LiveAgentTurn,
  mediaSteps: Readonly<Record<string, MediaStepStatus>>,
): void {
  const id = agent.tag.harnessSessionId
  const turns = entries.filter(
    (entry): entry is AgentTurn => entry.kind === 'agent' && entry.harnessSessionId === id,
  )
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
}

/** Between two Steps no turn is streaming, but the run is still going. */
function markRunsInFlight(turns: TimelineTurn[], inFlight: ReadonlyMap<string, RunProgress>): void {
  for (const turn of turns) {
    const progress = turn.kind === 'agent' && turn.runKey ? inFlight.get(turn.runKey) : undefined
    if (turn.kind !== 'agent' || !progress) continue
    turn.streaming = true
    turn.details = { ...turn.details, live: turn.details.live ?? { kind: 'working' }, progress }
  }
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

function mediaFailure(media: MediaTurnData, artifacts: TurnArtifact[]): GenerationFailure | null {
  if (media.status === 'completed') return null
  if (artifacts.some((artifact) => artifact.state === 'failed' || artifact.state === 'cancelled')) {
    return null
  }
  return generationFailure({ state: media.status, error: media.error })
}

export function timelineTurns(
  timeline: readonly unknown[],
  files: TimelineFiles = {},
  artifactRuns?: ArtifactRunsState,
  inFlight: ReadonlyMap<string, RunProgress> = new Map(),
): TimelineTurn[] {
  const messages = timeline.filter(isTimelineMessage)
  const turns: TimelineTurn[] = []
  const prompts = new Map<string, UIMessage>()
  const runs = new Map<string, AgentRun>()
  const latestRun = new Map<string, AgentRun>()
  // A Follow-up and its answers continue a run's Harness Session but are not its Steps.
  const followingUp = new Map<string, string>()
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const tag = agentTagOf(message)
    if (tag && isUIMessage(message) && message.role === 'user') {
      const agentName = followUpAgentName(message)
      if (agentName !== undefined) followingUp.set(tag.harnessSessionId, agentName)
      else followingUp.delete(tag.harnessSessionId)
    }
    const followUp = tag ? followingUp.get(tag.harnessSessionId) : undefined
    const marked =
      tag && followUp === undefined && isUIMessage(message) ? runTagOf(tag, message) : null
    let run = marked ? runs.get(marked.key) : undefined
    if (tag && marked && !run) {
      run = openRun(marked.key, message.id, tag, marked.run)
      runs.set(marked.key, run)
      turns.push(run.turn)
    }
    if (tag && !marked && (message as { role?: unknown }).role === 'assistant') {
      run = latestRun.get(tag.harnessSessionId)
    }
    if (tag && (message as { role?: unknown }).role === 'user') {
      if (run) latestRun.set(tag.harnessSessionId, run)
      else latestRun.delete(tag.harnessSessionId)
    }
    if (run && isUIMessage(message)) {
      if (marked?.run.end) run.end = marked.run.end
      if (message.role === 'user') run.steps.push({ prompt: message, answers: [] })
      else {
        if (run.steps.length === 0) run.steps.push({ answers: [] })
        run.steps.at(-1)!.answers.push(message)
        run.turn.answers.push(message)
      }
      continue
    }
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
          hint: agentHint(followUp ?? tag.presetName, []),
          details: EMPTY_DETAILS,
          result: [],
          footer: noFooter(),
          presetName: followUp ?? tag.presetName,
          harnessSessionId: tag.harnessSessionId,
          artifacts: [],
          audioArtifacts: [],
          ...(message.role === 'user'
            ? { prompt: messagePrompt(message), answers: [] }
            : { answers: [message] }),
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
  return withArtifacts(
    withAnswers(turns, prompts, runs, inFlight),
    files.deletedUrls ?? [],
    artifactRuns,
  )
}

/**
 * The turn holding the timeline's last message; a run's turn sits where its first message is.
 * `agentChatName` names the Agent of a Harness Session that was a chat with it, before Follow-ups.
 */
export function latestTurnOf(
  timeline: readonly unknown[],
  agentChatName: (harnessSessionId: string) => string | undefined = () => undefined,
): LatestTurn | undefined {
  const last = timeline.filter(isTimelineMessage).at(-1)
  if (!last) return undefined
  const tag = agentTagOf(last)
  if (tag) {
    const ranBy =
      followUpAgentName(last) ??
      tag.taskRun?.taskName ??
      agentChatName(tag.harnessSessionId) ??
      tag.presetName
    return { harnessSessionId: tag.harnessSessionId, ranBy }
  }
  const turn = timelineTurns(timeline)
    .filter((candidate) => candidate.kind !== 'agent' && candidate.kind !== 'message')
    .at(-1)
  return turn && 'hint' in turn ? { ranBy: turn.hint.preset } : undefined
}

export type AgentRunControls = { agentId: string }

/** A saved Agent's run opens its Agent for editing from its own Turn; Stop is the prompt bar's. */
export function agentRunControls<M, A>(turn: SessionTimelineItem<M, A>): AgentRunControls | null {
  if (turn.kind !== 'agent') return null
  const agentId = turn.prompt?.agentRun?.agentId
  return agentId ? { agentId } : null
}

function openRun(key: string, id: string, tag: AgentTurnTag, taskRun: AgentRunTag): AgentRun {
  const agentRun: AgentRunIdentity = {
    trigger: taskRun.trigger ?? 'manual',
    name: taskRun.taskName,
    startedAt: taskRun.startedAt,
    ...(taskRun.taskId ? { agentId: taskRun.taskId } : {}),
  }
  return {
    key,
    steps: [],
    turn: {
      kind: 'agent',
      id,
      hint: agentHint(agentRun.name, []),
      details: EMPTY_DETAILS,
      result: [],
      footer: noFooter(),
      presetName: tag.presetName,
      harnessSessionId: tag.harnessSessionId,
      runKey: key,
      artifacts: [],
      audioArtifacts: [],
      prompt: { text: '', agentRun },
      answers: [],
    },
  }
}
