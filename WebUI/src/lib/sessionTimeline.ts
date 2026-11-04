import type { UIMessage } from 'ai'
import type {
  AgentTurnTag,
  AudioTurnData,
  MediaTurnData,
  TaskRunTag,
  TimelineMessage,
  TimelinePart,
} from '@/types/sessionTimeline'
import type { AipgMetadata } from '@/assets/js/store/openAiCompatibleChat'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { messageHasVisibleContent, messageText } from '@/lib/chatMessageText'
import { asChatTranscriptMessage } from '@/lib/sessionChat'
import { toolPartMedia, turnArtifacts, type TurnArtifact } from '@/lib/turnArtifacts'

export type TurnHintKind = 'chat' | 'agent' | 'workflow' | 'speech'
export type TurnHintIcon = 'chat' | 'agent' | 'image' | 'video' | 'tts' | 'stt'

/** Which preset ran a Turn: its kind and name, with the model or engine for the tooltip. */
export type TurnHint = { kind: TurnHintKind; icon: TurnHintIcon; preset: string; detail?: string }

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
}

/**
 * One prompt and what it produced. `SessionTurn.vue` lays every kind out the same way —
 * prompt, hint, Turn Details, Result, footer — and the fields of each kind fill those slots.
 */
type TurnOf<K extends string, Body> = {
  kind: K
  id: string
  hint: TurnHint
  footer: TurnFooter
} & Body

/** A chat or agent Turn opened by an answer has no prompt. */
export type ChatTurn = TurnOf<
  'chat',
  { prompt?: TurnPrompt; answers: UIMessage[]; artifacts: TurnArtifact[] }
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
  { prompt: TurnPrompt; createdAt: number; audio: AudioTurnData }
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
}

/** What the timeline needs of an audio turn still running. */
export type PendingAudio = { kind: AudioTurnData['kind']; preset: string; prompt?: string }

/** Everything of the open Session still in flight, whichever preset or mode started it. */
export type LiveTurns<M extends PendingMedia, A extends PendingAudio> = {
  /** The Session's chat transcript as the chat store holds it, streaming turn included. */
  chat?: readonly { id: string }[]
  /** Each Harness Session of the Session that is open or running a turn (Task Runs too). */
  agents?: readonly LiveAgentTurn[]
  media?: M | null
  audio?: A | null
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
  | TurnOf<'pending-media', { prompt: TurnPrompt; pending: M }>
  | TurnOf<'pending-audio', { prompt: TurnPrompt; pending: A }>

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
  const turns = timelineTurns(merged, files)
  for (const agent of live.agents ?? []) markLiveAgentTurns(turns, agent)
  const items: SessionTimelineItem<M, A>[] = [...turns]
  const media = live.media
  if (media && !turns.some((turn) => turn.kind === 'media' && turn.media.runId === media.runId)) {
    items.push({
      kind: 'pending-media',
      id: media.runId,
      hint: mediaHint(media),
      prompt: textPrompt(media.prompt ?? '', media.preset, {
        inputImageUrl: media.inputImageUrl || undefined,
      }),
      footer: noFooter(),
      pending: media,
    })
  }
  if (live.audio) {
    const audio = live.audio
    items.push({
      kind: 'pending-audio',
      id: 'pending-audio',
      hint: audioHint(audio),
      prompt: textPrompt(audio.prompt ?? '', audio.preset),
      footer: noFooter(),
      pending: audio,
    })
  }
  const last = items.at(-1)
  if (last?.kind === 'chat') last.footer = chatAnswerFooter(last.answers, true)
  return items
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

/** Chat and agent answers arrive after their Turn is opened, so hint and footer are read last. */
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
  }
  return turns
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

function withArtifacts(turns: TimelineTurn[], deletedUrls: readonly string[]): TimelineTurn[] {
  for (const turn of turns) {
    if (turn.kind === 'chat' || turn.kind === 'agent') {
      const items = turn.answers.flatMap((answer) => answer.parts.flatMap(toolPartMedia))
      turn.artifacts = turnArtifacts(items, deletedUrls)
    }
    if (turn.kind === 'media') turn.artifacts = turnArtifacts(turn.media.items, deletedUrls)
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
          footer: noFooter(),
          presetName: tag.presetName,
          harnessSessionId: tag.harnessSessionId,
          artifacts: [],
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
        footer: noFooter(),
        artifacts: [],
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
        footer: audioFooter(audio),
        prompt: textPrompt(promptOf(message), audio.preset, {
          audio: audio.kind === 'stt' && audio.audioUrl ? [{ url: audio.audioUrl }] : undefined,
        }),
        createdAt: message.createdAt,
        audio,
      })
      i++
      continue
    }
    if (next && media) {
      turns.push({
        kind: 'media',
        id: next.id,
        hint: mediaHint(media),
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
  return withTaskRuns(withArtifacts(withAnswers(turns, prompts), files.deletedUrls ?? []))
}
