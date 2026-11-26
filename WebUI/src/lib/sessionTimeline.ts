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
import { isHarnessChatPreset } from '@/lib/harnessChatPreset'
import { mediaRerun } from '@/lib/mediaRerun'
import { reasoningElapsedMsFromParts } from '@/lib/reasoningTimings'
import { asChatTranscriptMessage, chatTranscriptOf } from '@/lib/sessionChat'
import { runInputOf } from '@/lib/taskSteps'
import { turnMessageIds, turnRemovalOf } from '@/lib/turnRemoval'
import {
  generationFailure,
  oneLine,
  placeholderArtifacts,
  runArtifacts,
  runFailure,
  screenshotToolArtifacts,
  toolCallArtifacts,
  toolCallFailureRecord,
  toolCallResultFailure,
  turnArtifacts,
  type GenerationFailure,
  type TurnArtifact,
} from '@/lib/turnArtifacts'
import {
  agentFooter,
  audioFooter,
  chatAnswerFooter,
  harnessTurnIds,
  noFooter,
} from '@/lib/turnFooter'
import { agentTurnHasChatAffordances } from '@/lib/chatAffordances'
import type { LatestTurn } from '@/lib/agentComposer'
import { modelDisplayName } from '@/lib/turnText'
import type {
  AgentRunIdentity,
  AgentTurn,
  AnswerDetailKind,
  AnswerPartRef,
  AudioRerun,
  AudioTurn,
  HarnessTurnRef,
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
  TurnFooter,
  TurnDetailPart,
  TurnDetails,
  TurnFooterAction,
  TurnHint,
  TurnHiding,
  TurnLiveStatus,
  TurnPrompt,
  TurnWorkflowHint,
  TurnResultPart,
  TurnSummary,
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

type AgentRun = { name: string; lastTurn: AgentTurn; end?: AgentRunTag['end'] }

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

/** An Agent Run fills its own Harness Session; older Sessions mark each run prompt instead. */
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

/**
 * A live list that starts where the stored transcript does is the whole chat, so a saved message
 * it lacks was truncated by a regenerate; one that starts mid-way (a resumed turn) keeps the rest.
 */
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
  const saved = chatTranscriptOf(timeline)
  const wholeHistory = saved.length === 0 || saved[0].id === live[0].id
  const merged = timeline.flatMap((value) => {
    const stored = asChatTranscriptMessage(value)
    if (!stored) return [value]
    const copy = tagged.get(stored.id)
    if (!copy) return wholeHistory ? [] : [value]
    tagged.delete(stored.id)
    return [{ ...copy, metadata: { ...stored.metadata, ...copy.metadata } }]
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
  const turns = timelineTurns(merged, files, live.artifactRuns)
  const mediaSteps = live.mediaSteps ?? {}
  for (const agent of live.agents ?? []) markLiveAgentTurns(turns, agent, mediaSteps)
  markRunsInFlight(turns, live.agentRunsInFlight ?? [])
  for (const turn of turns) if (turn.kind === 'agent' && turn.streaming) turn.footer = noFooter()
  markLiveChatTurn(turns, live.chatStatus, mediaSteps, live.chatStopping ?? false)
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
  // Redoing or deleting an earlier Agent Turn would rewind, or leave a gap under, the turns after it.
  for (const item of items) {
    if (item.kind !== 'agent' || item === last) continue
    item.footer.actions = item.footer.actions.filter(
      (action) => action !== 'regenerate' && action !== 'edit' && action !== 'delete',
    )
  }
  if (last?.kind === 'chat') {
    // An answer that settled empty (failed or interrupted) can still be deleted, unless replayed.
    const answer = last.answers.at(-1)
    const replayed = last.answers.some((message) =>
      isHarnessChatPreset((message.metadata as { preset?: string } | undefined)?.preset),
    )
    let footer = chatAnswerFooter(last.answers, true)
    if (
      footer.actions.length === 0 &&
      answer &&
      !last.details.live &&
      !live.chatStatus?.running &&
      !replayed
    ) {
      footer = { actions: ['delete'], text: '', messageId: answer.id }
    }
    last.footer = withHide(footer, last)
    if (last.prompt && last.footer.actions.includes('regenerate')) {
      last.footer.actions = withEditAction(last.footer.actions)
    }
  }
  if (last?.kind === 'media') {
    const rerun = mediaRerun(last)
    // A run that failed before recording its settings cannot rerun, but still deletes.
    last.footer = withHide(
      {
        actions: rerun ? ['regenerate', 'edit', 'delete'] : ['delete'],
        text: '',
        ...(rerun ? { rerun } : {}),
        deletion: { owner: 'media', ...turnRemovalOf(last) },
      },
      last,
    )
  }
  if (last?.kind === 'audio') {
    const rerun = audioRerunOf(last)
    // STT's prompt is only the source clip's label: it reruns but cannot be edited.
    const actions: TurnFooterAction[] = [
      ...last.footer.actions.filter((action) => action !== 'hide'),
      ...(rerun
        ? (['regenerate', ...(rerun.kind === 'tts' ? (['edit'] as const) : [])] as const)
        : []),
      'delete',
      'hide',
    ]
    last.footer = {
      ...last.footer,
      actions: [...new Set(actions)],
      ...(rerun ? { audioRerun: rerun } : {}),
      deletion: { owner: 'audio', ...turnRemovalOf(last) },
    }
  }
  return items
}

/** For views that must not offer Hide: hiding switched off, or a Trial Run. */
export function withoutMessageHiding<M, A>(
  items: SessionTimelineItem<M, A>[],
): SessionTimelineItem<M, A>[] {
  for (const item of items) {
    if (item.kind === 'message') continue
    if (!item.footer.actions.includes('hide') && !item.footer.hiding) continue
    const { hiding: _hiding, ...footer } = item.footer
    item.footer = { ...footer, actions: footer.actions.filter((action) => action !== 'hide') }
  }
  return items
}

/** A live merge appends whatever the saved timeline lacks, so hidden messages must leave the live copy too. */
export function visibleLiveMessages<M extends { id?: string }>(
  messages: readonly M[],
  hiddenIds: readonly string[],
): M[] {
  if (hiddenIds.length === 0) return [...messages]
  return messages.filter((message) => !hiddenIds.includes(message.id ?? ''))
}

function textPrompt(
  text: string,
  preset: string,
  extra: Omit<TurnPrompt, 'text' | 'placeholder'> = {},
): TurnPrompt {
  const defined = Object.entries(extra).filter(([, value]) => value !== undefined)
  return { text, ...(text ? {} : { placeholder: preset }), ...Object.fromEntries(defined) }
}

/** `edit` sits beside `regenerate`: both re-run the turn, one from an edited prompt. */
function withEditAction(actions: TurnFooterAction[]): TurnFooterAction[] {
  const at = actions.includes('regenerate') ? actions.indexOf('regenerate') + 1 : actions.length
  return [...actions.slice(0, at), 'edit', ...actions.slice(at)]
}

function turnHidingOf(turn: TimelineTurn): TurnHiding {
  if (turn.kind === 'media' || turn.kind === 'audio') return { messageIds: turnMessageIds(turn) }
  if (turn.kind === 'message') return { messageIds: [turn.id] }
  return {
    messageIds: [
      ...new Set([...(turn.prompt ? [turn.id] : []), ...turn.answers.map((answer) => answer.id)]),
    ],
  }
}

function withHide(footer: TurnFooter, turn: TimelineTurn): TurnFooter {
  return { ...footer, actions: [...footer.actions, 'hide'], hiding: turnHidingOf(turn) }
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

/**
 * The media workflows a chat or agent turn's tools ran, for its header: an
 * artifact names the workflow it came from, so the header can say it without
 * expanding the Turn. A run still in flight already carries the name, because
 * the runner stamps every item with its preset when the run registers.
 */
function turnWorkflowHints(artifacts: readonly TurnArtifact[]): TurnWorkflowHint[] | undefined {
  const byPreset = new Map<string, { icon: 'image' | 'video'; variants: Set<string> }>()
  for (const artifact of artifacts) {
    const { preset, variant } = artifact.item.settings ?? {}
    if (typeof preset !== 'string' || !preset) continue
    const entry = byPreset.get(preset) ?? {
      icon: artifact.mediaType === 'video' ? ('video' as const) : ('image' as const),
      variants: new Set<string>(),
    }
    if (typeof variant === 'string' && variant) entry.variants.add(variant)
    byPreset.set(preset, entry)
  }
  if (byPreset.size === 0) return undefined
  return [...byPreset.entries()].map(([preset, { icon, variants }]) => ({
    preset,
    icon,
    ...(variants.size === 1 ? { variant: [...variants][0] } : {}),
  }))
}

/** Answers arrive after their Turn opens, so hint, sections and footer are read last. */
function withAnswers(
  turns: TimelineTurn[],
  prompts: Map<string, UIMessage>,
  runs: Map<string, AgentRun>,
): TimelineTurn[] {
  for (const turn of turns) {
    if (turn.kind === 'chat') {
      turn.hint = chatHint(prompts.get(turn.id), turn.answers)
      turn.footer = chatAnswerFooter(turn.answers)
    }
    if (turn.kind === 'chat' || turn.kind === 'agent') {
      Object.assign(turn, answerSections(turn.kind, turn.answers))
    }
    if (turn.kind === 'agent') {
      const run = turn.runKey ? runs.get(turn.runKey) : undefined
      turn.hint = agentHint(run?.name ?? turn.presetName, turn.answers)
      if (run?.lastTurn === turn) turn.result = [...turn.result, ...runEndFailure(run.end)]
      turn.footer = agentFooter(resultText(turn), {
        answer: turn.answers.at(-1),
        harnessTurn: harnessTurnOf(turn),
        latest: turn === turns.at(-1),
        canSpeak: agentTurnHasChatAffordances(turn.presetName),
      })
    }
    if (turn.kind !== 'message') turn.footer = withHide(turn.footer, turn)
  }
  return turns
}

function harnessTurnOf(turn: AgentTurn): HarnessTurnRef | undefined {
  return {
    harnessSessionId: turn.harnessSessionId,
    ...(turn.prompt ? { promptId: turn.id } : {}),
    messageIds: [...(turn.prompt ? [turn.id] : []), ...turn.answers.map((answer) => answer.id)],
    turnIds: harnessTurnIds(turn.answers),
  }
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

/** Why a run ended early, on its last turn before any Follow-up. */
function runEndFailure(end: AgentRunTag['end']): TurnResultPart[] {
  if (!end) return []
  const state = end.kind === 'failed' ? 'failed' : 'cancelled'
  return [{ kind: 'failure', ...generationFailure({ state, error: end.message }) }]
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
  // A web capture is something to look at, not a step toward the answer.
  if (screenshotToolArtifacts(part, []).length > 0) return { details: 'tool', result: true }
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

/** Regenerate re-runs the latest audio turn's input, which needs the text spoken or the source clip. */
function audioRerunOf(turn: AudioTurn): AudioRerun | null {
  if (!turn.promptId) return null
  if (turn.audio.kind === 'tts' && !turn.prompt.text.trim()) return null
  if (turn.audio.kind === 'stt' && !turn.audio.audioUrl) return null
  return {
    kind: turn.audio.kind,
    preset: turn.audio.preset,
    prompt: turn.prompt.text,
    ...(turn.audio.audioUrl ? { audioUrl: turn.audio.audioUrl } : {}),
    messageIds: turnMessageIds(turn),
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
  stopping: boolean,
): void {
  const turn = entries.findLast((entry) => entry.kind === 'chat')
  if (turn?.kind !== 'chat') return
  if (stopping) {
    turn.details = { ...turn.details, live: { kind: 'stopping', stillStopping: false } }
    if (status?.questionKey) turn.questionKey = status.questionKey
    return
  }
  if (!status) return
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
  }
}

/** A run in flight is live on its Harness Session's newest turn, even before that one streams. */
function markRunsInFlight(turns: TimelineTurn[], inFlight: readonly string[]): void {
  const agentTurns = turns.filter((turn): turn is AgentTurn => turn.kind === 'agent')
  for (const key of inFlight) {
    const harness = agentTurns.find((turn) => turn.runKey === key)?.harnessSessionId
    const newest = agentTurns.findLast((turn) => turn.harnessSessionId === harness)
    if (!harness || !newest) continue
    newest.streaming = true
    newest.details = { ...newest.details, live: newest.details.live ?? { kind: 'working' } }
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
      const workflows = turnWorkflowHints(turn.artifacts)
      if (workflows) turn.details = { ...turn.details, workflows }
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
): TimelineTurn[] {
  const messages = timeline.filter(isTimelineMessage)
  const turns: TimelineTurn[] = []
  const prompts = new Map<string, UIMessage>()
  const runs = new Map<string, AgentRun>()
  // A Follow-up and its answers continue a run's Harness Session but are not part of the run.
  const followingUp = new Map<string, string>()
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    const tag = agentTagOf(message)
    if (tag && isUIMessage(message)) {
      if (message.role === 'user') {
        const agentName = followUpAgentName(message)
        if (agentName !== undefined) followingUp.set(tag.harnessSessionId, agentName)
        else followingUp.delete(tag.harnessSessionId)
      }
      const followUp = followingUp.get(tag.harnessSessionId)
      const marked = followUp === undefined ? runTagOf(tag, message) : null
      let run = marked ? runs.get(marked.key) : undefined
      const last = turns.at(-1)
      if (
        message.role === 'assistant' &&
        last?.kind === 'agent' &&
        last.harnessSessionId === tag.harnessSessionId
      ) {
        last.answers.push(message)
      } else {
        if (message.role === 'user') prompts.set(message.id, message)
        const turn: AgentTurn = {
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
            ? {
                prompt:
                  marked && !run ? runStartPrompt(marked.run, message) : messagePrompt(message),
                answers: [],
              }
            : { answers: [message] }),
        }
        if (marked) {
          turn.runKey = marked.key
          if (run) run.lastTurn = turn
          else {
            run = { name: marked.run.taskName, lastTurn: turn }
            runs.set(marked.key, run)
          }
        }
        turns.push(turn)
      }
      const end = marked?.run.end
      if (run && end) run.end = end
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
        promptId: message.id,
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
        promptId: message.id,
      })
      i++
      continue
    }
    turns.push({ kind: 'message', id: message.id, message })
  }
  return withArtifacts(withAnswers(turns, prompts, runs), files.deletedUrls ?? [], artifactRuns)
}

/**
 * The turn holding the timeline's last message.
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

/** A saved Agent's run opens its Agent for editing from its start bubble; Stop is the prompt bar's. */
export function agentRunControls<M, A>(turn: SessionTimelineItem<M, A>): AgentRunControls | null {
  if (turn.kind !== 'agent') return null
  const agentId = turn.prompt?.agentRun?.agentId
  return agentId ? { agentId } : null
}

/** A run's first prompt: what started it and its Start Prompt, the full prompt kept to expand. */
function runStartPrompt(taskRun: AgentRunTag, message: UIMessage): TurnPrompt {
  const prompt = messageText(message)
  const agentRun: AgentRunIdentity = {
    trigger: taskRun.trigger ?? 'manual',
    ...(taskRun.channel ? { channel: taskRun.channel } : {}),
    name: taskRun.taskName,
    startedAt: taskRun.startedAt,
    ...(taskRun.taskId ? { agentId: taskRun.taskId } : {}),
    prompt,
  }
  return { text: taskRun.input || (runInputOf(prompt) ?? ''), agentRun }
}
