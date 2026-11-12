import { answerRouterCopy, type AnswerRouterCopy } from '@/lib/answerRouterWording'
import { fillTemplate } from '@/lib/fillTemplate'
import type { AgentAnswerOrigin } from '@/types/agentIpc'
import {
  isStartPromptRequest,
  isTrialRunMessage,
  isTrialRunOwner,
  type AnswerTarget,
  type ChannelMessageOwner,
  type SessionMessageOwner,
  type TrialRunMessageOwner,
  type TrialRunOwner,
} from '@/types/notificationsIpc'
import {
  ANSWER_CALLBACK,
  answerGesture,
  GESTURE_WORDING,
  hasAnswerTyping,
} from '@/lib/answerButton'
import type { ChannelAdapter, RawPart } from './adapter'
import { helpText, parseCommand, type ChannelCommand } from './channelCommands'
import type { ChannelQuestionRegistry, InboundAnswer } from './channelQuestions'
import {
  answerMeta,
  attachedPrompt,
  fileRefusal,
  inboundOrigin,
  replyReachable,
  type AttachResult,
  type ChannelFile,
} from './channelInbound'
import {
  CHANNEL_QUEUE_LIMIT,
  combineMessages,
  createChannelQueue,
  type ChannelQueue,
  type ChannelTurnMessage,
  type QueuedChannelMessage,
  type QueuedEntry,
} from './channelQueue'
import { createChannelSessions } from './channelSessions'
import { createChannelAgents } from './channelAgents'
import { createChannelStartPrompts } from './channelStartPrompts'
import { createStartPromptRequests, type StartPromptRequests } from './startPromptRequests'
import type { ChannelKind, InboundMeta, RemoteAudio, RemoteDocument, RemoteImage } from './types'

/** How sending into a Session went; `queuePosition` is set while it waits its turn. */
export type SessionSendResult =
  { ok: true; queuePosition: number | null } | { ok: false; reason: string; message: string }

/** How starting an Agent Run went; a busy Session takes the start once its turn ends. */
export type AgentStartResult = { ok: true } | { ok: false; reason: string; message: string }

/** A later Step of a Channel-started Agent Run that the window refused to send, ending the run. */
export type AgentRunRefusal = {
  origin: AgentAnswerOrigin
  name: string
  step: number
  reason: string
}

/** An Agent marked "Can be started from a Channel". */
export type StartableAgent = { agentId: string; name: string }

/** What a paused turn waits on: the download buttons in the channel, or the computer. */
export type SessionPause = 'download' | 'desktop'

/** What a Session is busy with: a queued message waits for it to end. */
export type SessionActivity =
  | { kind: 'idle' }
  | { kind: 'turn'; paused?: SessionPause }
  | { kind: 'agent-run'; name: string; step: number; steps: number }

/** The Session's turn and Agent Run are over, or it can no longer take queued messages. */
export type SessionChange = 'settled' | 'unreachable' | 'deleted'

/** A plain message goes to the Session's Assistant; an Answer to the Harness Session that asked. */
export type SessionTarget = { sessionRef: string } | AnswerTarget

/** An Answer to a Trial Run, by its Harness Session: it belongs to no Session (ADR 0011). */
export type TrialRunTarget = { trialRunSessionId: string }

/** Where a Channel's message runs: a Session, or a Trial Run it answers. */
export type ChannelTarget = SessionTarget | TrialRunTarget

/** The Trial Run's turn and Steps are over, or it was thrown away with its Harness Session. */
export type TrialRunChange = 'settled' | 'thrown-away'

/** One message of a Session's transcript, for repainting a Channel that keeps no history. */
export type ChannelTranscriptMessage = { role: 'user' | 'assistant'; parts: RawPart[] }

/** Each Channel's Channel Session, kept by the window across restarts. */
export type ChannelSessionPointers = {
  get: (kind: ChannelKind) => string | null
  set: (kind: ChannelKind, sessionRef: string | null) => void
}

/** The Sessions a channel reaches, keyed by Session (`docs/adr/0010`); registered by the window. */
export type SessionPort = {
  /** The Session has not been deleted. */
  exists: (sessionRef: string) => Promise<boolean>
  /** The Session exists and is a Reachable Session; nothing else is ever driven from a channel. */
  isReachable: (sessionRef: string) => Promise<boolean>
  /** The Reachable Sessions, newest first; an untitled one has an empty title. */
  listReachable: () => Promise<{ sessionRef: string; title: string }[]>
  /** A new Reachable Session, not opened on the desktop; throws when it could not be made. */
  create: () => Promise<string>
  transcript: (sessionRef: string) => Promise<ChannelTranscriptMessage[]>
  /** The Session and Harness Session that sent this channel message, or null when none did. */
  lookup: (kind: ChannelKind, ref: string) => Promise<ChannelMessageOwner | null>
  /** Puts a posted Start Prompt Request in the message map, to be recognized after a restart. */
  recordStartPromptRequest: (kind: ChannelKind, ref: string) => Promise<void>
  /** The label, quoted (`"Asteroids clone"`, or a Task and its step for an Answer). */
  label: (target: ChannelTarget) => string
  /** The folder runs the real system shell, which is never driven from a channel. */
  usesRealShell: (target: AnswerTarget) => boolean
  /**
   * The Harness Session the target's turn runs in, without minting one: the Session ref stands
   * for its Assistant Harness Session. Queued messages with the same turn target combine.
   */
  turnTarget: (target: ChannelTarget) => string
  /**
   * Stores an image in the attachments of the target's workspace, or a document there as an
   * Attached Document; an image is refused when the target's model cannot see images.
   */
  attach: (target: ChannelTarget, file: ChannelFile) => Promise<AttachResult>
  /**
   * `origin` is where the message came from; the turn's result is replied under it. A plain
   * message runs in the Session's Assistant Harness Session, minted on first use; an Answer to a
   * Trial Run runs as its Follow-up, refused as `thrown-away` once it is gone.
   */
  send: (
    target: ChannelTarget,
    message: string,
    origin: AgentAnswerOrigin,
  ) => Promise<SessionSendResult>
  /** The Agents marked "Can be started from a Channel", in the Agent Library's order. */
  listStartableAgents: () => Promise<StartableAgent[]>
  /** A saved Agent's name, startable from a Channel or not; null when there is no such Agent. */
  agentName: (agentId: string) => string | null
  /**
   * Starts an Agent Run of the Agent in the Session on its Settings Template, with `prompt` as its
   * Start Prompt when given; the run's result is replied under `origin`.
   */
  startAgent: (
    sessionRef: string,
    agentId: string,
    origin: AgentAnswerOrigin,
    prompt?: string,
  ) => Promise<AgentStartResult>
  /** The Session's turn in flight, or its Agent Run (also between Steps). */
  activity: (sessionRef: string) => SessionActivity
  /** Stops the Session's turn or Agent Run, the run's next Step included; returns what it was. */
  stop: (sessionRef: string) => Promise<SessionActivity>
  /** Hear each Session settle, become unreachable or be deleted; returns the unsubscribe. */
  onSessionChange: (listener: (sessionRef: string, change: SessionChange) => void) => () => void
  /** Hear a Channel-started run's later Step refused by the window; returns the unsubscribe. */
  onAgentRunRefused: (
    listener: (sessionRef: string, refusal: AgentRunRefusal) => void,
  ) => () => void
  /** The window still holds this Trial Run: it is neither superseded nor discarded. */
  trialRunLive: (harnessSessionId: string) => boolean
  /** The Trial Run's Step or Follow-up in flight, also between its Steps. */
  trialRunActivity: (harnessSessionId: string) => SessionActivity
  /** Hear each Trial Run settle or be thrown away; returns the unsubscribe. */
  onTrialRunChange: (
    listener: (harnessSessionId: string, change: TrialRunChange) => void,
  ) => () => void
}

/**
 * An inbound channel message: `replyTo` is the platform id of the message it replies
 * to, `replyTarget` the ref a reply to this message names.
 */
export type InboundChannelMessage = InboundAnswer & {
  replyTo?: string
  replyTarget?: string
  images?: RemoteImage[]
  audio?: RemoteAudio[]
  documents?: RemoteDocument[]
  /** The channel's notice for a file it refused to read. */
  refused?: string
  /** The text was spoken: a voice message, transcribed. */
  voice?: boolean
}

export type AnswerRouter = {
  /**
   * Routes everything a Channel sends: a button tap to its Channel Question or command, a
   * command, a reply to a Session's message to that Harness Session as an Answer, a typed yes/no
   * to an open confirmation, and anything else to the Channel's Channel Session.
   */
  route: (adapter: ChannelAdapter, msg: InboundChannelMessage, meta?: InboundMeta) => Promise<void>
}

/** Speech-to-text for a voice message: usable now, refused (the channel was told why), or downloading. */
export type VoicePreparation = { ready: boolean } | { downloading: Promise<boolean> }

/** A Channel's speech-to-text; a null transcript means it failed and already told the channel why. */
export type ChannelSpeech = {
  prepare: (adapter: ChannelAdapter, meta?: InboundMeta) => Promise<VoicePreparation>
  transcribe: (
    adapter: ChannelAdapter,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ) => Promise<string | null>
}

export type AnswerRouterDeps = {
  /** Null until the window has registered it; messages are dropped until then. */
  sessions: () => SessionPort | null
  pointers: ChannelSessionPointers
  questions: Pick<ChannelQuestionRegistry, 'handleInbound'>
  /** Voice messages are dropped without it. */
  speech?: ChannelSpeech
  /** The Channels an agent's download question is asked on; empty when only the computer asks. */
  downloadQuestionChannels?: () => readonly ChannelKind[]
  copy?: () => AnswerRouterCopy
  /** Each Session's queued messages as they change, for its timeline and In-flight Work. */
  publishQueue?: (sessionRef: string, queued: QueuedChannelMessage[]) => void
  /** A Session's taken batch is being sent; a desktop prompt waits until it has gone. */
  publishSending?: (sessionRef: string, sending: boolean) => void
  /** Where posted Start Prompt Requests are kept; in memory unless given. */
  startPromptRequests?: StartPromptRequests
  /** Where failures that reach no channel go: the window's error sink. */
  log: (message: string, error: unknown) => void
}

// Refusals the user can only clear on the computer, so the reply says where to go.
const FIXED_ON_DESKTOP = new Set(['missing-folder', 'settings-problems'])

/** How a submitted message or Agent start went: sent, waiting in the Session's queue, or refused. */
type SubmitOutcome = 'started' | 'queued' | 'refused'

/** A message, or an Agent start, waiting for its Session's or Trial Run's turn to end. */
type QueuedMessage = {
  adapter: ChannelAdapter
  origin: AgentAnswerOrigin
  meta?: InboundMeta
} & (
  | { target: ChannelTarget; message: ChannelTurnMessage }
  | {
      target: { sessionRef: string }
      agent: StartableAgent
      prompt?: string
      settled?: (started: boolean) => void
    }
)

/** One Session's or Trial Run's queue; `key` is unique across both. */
type Lane = {
  key: string
  id: string
  target: { sessionRef: string } | TrialRunTarget
  queue: ChannelQueue<QueuedMessage>
  activity: () => SessionActivity
  publishSending: (sending: boolean) => void
}

type DropReason = 'stopped' | 'unreachable' | 'deleted' | 'thrown-away'

export function createAnswerRouter(deps: AnswerRouterDeps): AnswerRouter {
  const copy = deps.copy ?? answerRouterCopy
  const log = deps.log
  const downloadQuestionChannels = deps.downloadQuestionChannels ?? (() => [])
  const startPromptRequests =
    deps.startPromptRequests ??
    createStartPromptRequests({
      record: async (kind, ref) => deps.sessions()?.recordStartPromptRequest(kind, ref),
      lookup: async (kind, ref) => (await deps.sessions()?.lookup(kind, ref)) ?? null,
    })

  const queue = createChannelQueue<QueuedMessage>({ onChange: deps.publishQueue })
  // The desktop shows a Session's queue only; a Trial Run's is the router's alone.
  const trialRunQueue = createChannelQueue<QueuedMessage>()
  let agentStarts = 0
  // Lanes whose next queued batch is being sent.
  const draining = new Set<string>()
  // Per Channel: its messages behind a voice message whose speech model downloads, in order.
  const waitingForSpeech = new Map<ChannelKind, Promise<void>>()
  // Per Session: where its Agent Run was started from a Channel, for a refused Step to be told.
  const agentRunStarts = new Map<string, { adapter: ChannelAdapter; meta?: InboundMeta }>()
  let unsubscribe: (() => void) | null = null
  let subscribedTo: SessionPort | null = null

  function listen(sessions: SessionPort): void {
    if (subscribedTo === sessions) return
    unsubscribe?.()
    subscribedTo = sessions
    const stopChanges = sessions.onSessionChange((sessionRef, change) => {
      const lane = laneOf(sessions, { sessionRef })
      if (change === 'settled') void drain(sessions, lane)
      else void dropQueue(sessions, lane, change)
    })
    const stopRefusals = sessions.onAgentRunRefused((sessionRef, refusal) => {
      void tellRunRefused(sessions, sessionRef, refusal)
    })
    const stopTrialChanges = sessions.onTrialRunChange((harnessSessionId, change) => {
      const lane = laneOf(sessions, { trialRunSessionId: harnessSessionId })
      if (change === 'settled') void drain(sessions, lane)
      else void dropQueue(sessions, lane, change)
    })
    unsubscribe = () => {
      stopChanges()
      stopRefusals()
      stopTrialChanges()
    }
  }

  function laneOf(sessions: SessionPort, target: ChannelTarget): Lane {
    if ('trialRunSessionId' in target) {
      const id = target.trialRunSessionId
      return {
        key: `trial-run:${id}`,
        id,
        target: { trialRunSessionId: id },
        queue: trialRunQueue,
        activity: () => sessions.trialRunActivity(id),
        publishSending: () => {},
      }
    }
    const id = target.sessionRef
    return {
      key: id,
      id,
      target: { sessionRef: id },
      queue,
      activity: () => sessions.activity(id),
      publishSending: (sending) => deps.publishSending?.(id, sending),
    }
  }

  async function tellRunRefused(
    sessions: SessionPort,
    sessionRef: string,
    refusal: AgentRunRefusal,
  ): Promise<void> {
    const started = agentRunStarts.get(sessionRef)
    if (!started || started.adapter.kind !== refusal.origin.channel) return
    agentRunStarts.delete(sessionRef)
    const text = fillTemplate(copy().agentStepRefused, {
      name: refusal.name,
      step: refusal.step,
      title: sessions.label({ sessionRef }),
      reason: refusal.reason,
    })
    await tell(started.adapter, text, started.meta)
  }

  async function send(
    sessions: SessionPort,
    target: ChannelTarget,
    text: string,
    origin: AgentAnswerOrigin,
  ): Promise<SessionSendResult> {
    try {
      return await sessions.send(target, text, origin)
    } catch (e) {
      return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }

  async function confirm(
    adapter: ChannelAdapter,
    title: string,
    result: SessionSendResult,
    meta?: InboundMeta,
  ): Promise<void> {
    const wording = copy()
    if (!result.ok && result.reason === 'no-session') {
      await tell(adapter, wording.noSession, meta)
    } else if (!result.ok && result.reason === 'thrown-away') {
      await tell(adapter, wording.trialRunThrownAway, meta)
    } else if (!result.ok) {
      const notSent = fillTemplate(wording.notSent, { title, reason: result.message })
      const fixable = FIXED_ON_DESKTOP.has(result.reason)
      await tell(adapter, fixable ? `${notSent}\n${wording.fixOnDesktop}` : notSent, meta)
    } else if (result.queuePosition !== null) {
      const position = String(result.queuePosition)
      await tell(adapter, fillTemplate(wording.queued, { title, position }), meta)
    } else if (!hasAnswerTyping(adapter.kind)) {
      await tell(adapter, fillTemplate(wording.starting, { title }), meta)
    }
  }

  async function startAgent(
    sessions: SessionPort,
    sessionRef: string,
    agent: StartableAgent,
    origin: AgentAnswerOrigin,
    prompt?: string,
  ): Promise<AgentStartResult> {
    try {
      return await sessions.startAgent(sessionRef, agent.agentId, origin, prompt)
    } catch (e) {
      return { ok: false, reason: 'error', message: e instanceof Error ? e.message : String(e) }
    }
  }

  /** The Notifier says an Agent Run started, once its first Step runs; only a refusal is told here. */
  async function confirmStart(
    sessions: SessionPort,
    entry: QueuedMessage & { agent: StartableAgent },
    result: AgentStartResult,
  ): Promise<void> {
    if (result.ok) return
    const wording = copy()
    const title = sessions.label(entry.target)
    const notStarted = fillTemplate(wording.agentNotStarted, {
      name: entry.agent.name,
      title,
      reason: result.message,
    })
    const fixable = FIXED_ON_DESKTOP.has(result.reason)
    await tell(
      entry.adapter,
      fixable ? `${notStarted}\n${wording.agentFixOnDesktop}` : notStarted,
      entry.meta,
    )
  }

  /** `busy` when the Session turned out busy, so the entry has to wait for it. */
  async function run(
    sessions: SessionPort,
    entry: QueuedMessage,
    text?: string,
  ): Promise<Exclude<SubmitOutcome, 'queued'> | 'busy'> {
    if ('agent' in entry) {
      const { sessionRef } = entry.target
      const result = await startAgent(sessions, sessionRef, entry.agent, entry.origin, entry.prompt)
      if (!result.ok && isBusy(result.reason)) return 'busy'
      if (result.ok) agentRunStarts.set(sessionRef, { adapter: entry.adapter, meta: entry.meta })
      entry.settled?.(result.ok)
      await confirmStart(sessions, entry, result)
      return result.ok ? 'started' : 'refused'
    }
    const result = await send(sessions, entry.target, text ?? entry.message.text, entry.origin)
    if (!result.ok && isBusy(result.reason)) return 'busy'
    await confirm(entry.adapter, sessions.label(entry.target), result, entry.meta)
    return result.ok ? 'started' : 'refused'
  }

  /** Sends a Channel's message into its Session or Trial Run, or queues it while that is busy. */
  async function submit(sessions: SessionPort, entry: QueuedMessage): Promise<SubmitOutcome> {
    listen(sessions)
    const lane = laneOf(sessions, entry.target)
    if (lane.queue.size(lane.id) > 0 || draining.has(lane.key) || lane.activity().kind !== 'idle') {
      return enqueue(sessions, lane, entry)
    }
    const outcome = await run(sessions, entry)
    return outcome === 'busy' ? enqueue(sessions, lane, entry) : outcome
  }

  function previewOf(entry: QueuedMessage): string {
    if (!('agent' in entry)) return entry.message.text
    const command = `/agents ${entry.agent.name}`
    return entry.prompt ? `${command}\n${entry.prompt}` : command
  }

  async function enqueue(
    sessions: SessionPort,
    lane: Lane,
    entry: QueuedMessage,
  ): Promise<Exclude<SubmitOutcome, 'started'>> {
    const wording = copy()
    const title = sessions.label(entry.target)
    const position = lane.queue.add(lane.id, {
      channel: entry.adapter.kind,
      batchKey:
        'agent' in entry ? `agent-start-${++agentStarts}` : sessions.turnTarget(entry.target),
      preview: previewOf(entry),
      item: entry,
    })
    if (position === null) {
      if ('agent' in entry) entry.settled?.(false)
      const full = fillTemplate(wording.queueFull, { title, limit: CHANNEL_QUEUE_LIMIT })
      await tell(entry.adapter, full, entry.meta)
      return 'refused'
    }
    const activity = lane.activity()
    const waitingFor =
      activity.kind === 'agent-run'
        ? fillTemplate(wording.queueAfterAgentRun, {
            name: activity.name,
            step: activity.step,
            steps: activity.steps,
          })
        : wording.queueAfterTurn
    const ack = fillTemplate(wording.queuedMessage, {
      position: wording.ordinal(position),
      title,
      waitingFor,
    })
    const pause = activity.kind === 'turn' ? activity.paused : undefined
    const pauseLine = pause ? pauseNote(pause, entry.adapter.kind, wording) : null
    await tell(entry.adapter, pauseLine ? `${ack}\n${pauseLine}` : ack, entry.meta)
    // The Session may have settled while the message was refused or acknowledged.
    await drain(sessions, lane)
    return 'queued'
  }

  function pauseNote(pause: SessionPause, kind: ChannelKind, wording: AnswerRouterCopy): string {
    if (pause === 'desktop') return wording.queueWaitsDesktop
    const askedOn = downloadQuestionChannels()
    if (askedOn.includes(kind)) return wording.queueWaitsDownload
    return askedOn.length > 0 ? wording.queueWaitsDownloadElsewhere : wording.queueWaitsDesktop
  }

  /** Runs the oldest Channel's queued messages as one turn once the Session is idle. */
  async function drain(sessions: SessionPort, lane: Lane): Promise<void> {
    while (!draining.has(lane.key) && lane.activity().kind === 'idle') {
      const batch = lane.queue.takeBatch(lane.id)
      if (batch.length === 0) return
      draining.add(lane.key)
      lane.publishSending(true)
      try {
        const busy = await sendBatch(sessions, lane, batch)
        if (busy) return
      } finally {
        draining.delete(lane.key)
        lane.publishSending(false)
      }
    }
  }

  /** True when the Session turned out busy and the batch went back to wait for it. */
  async function sendBatch(
    sessions: SessionPort,
    lane: Lane,
    batch: QueuedEntry<QueuedMessage>[],
  ): Promise<boolean> {
    const last = batch[batch.length - 1].item
    const messages = batch.flatMap(({ item }) => ('message' in item ? [item.message] : []))
    const replyTo = batch.findLast((entry) => entry.item.origin.replyTo)?.item.origin.replyTo
    const voice = batch.some((entry) => entry.item.origin.voice)
    const origin = { ...last.origin, ...(replyTo ? { replyTo } : {}), ...(voice ? { voice } : {}) }
    const outcome = await run(sessions, { ...last, origin }, combineMessages(messages).text)
    const busy = outcome === 'busy'
    if (busy) lane.queue.putBack(lane.id, batch)
    return busy
  }

  /** Drops the lane's queue, telling each Channel but `except` how many of its messages went. */
  async function dropQueue(
    sessions: SessionPort,
    lane: Lane,
    why: DropReason,
    except?: ChannelKind,
  ): Promise<number> {
    const dropped = lane.queue.drop(lane.id)
    for (const { item } of dropped) if ('agent' in item) item.settled?.(false)
    const wording = copy()
    const template = {
      stopped: wording.queueDroppedStopped,
      unreachable: wording.queueDroppedUnreachable,
      deleted: wording.queueDroppedDeleted,
      'thrown-away': wording.queueDroppedThrownAway,
    }[why]
    const title = sessions.label(lane.target)
    const byChannel = new Map<ChannelKind, QueuedEntry<QueuedMessage>[]>()
    for (const entry of dropped) {
      byChannel.set(entry.channel, [...(byChannel.get(entry.channel) ?? []), entry])
    }
    for (const [kind, entries] of byChannel) {
      if (kind === except) continue
      const last = entries[entries.length - 1].item
      await tell(last.adapter, fillTemplate(template, { title, count: entries.length }), last.meta)
    }
    return dropped.length
  }

  /** The Session or Trial Run whose message `ref` is; a Start Prompt Request is neither. */
  async function answered(
    sessions: SessionPort,
    kind: ChannelKind,
    ref: string,
  ): Promise<SessionMessageOwner | TrialRunMessageOwner | null> {
    try {
      const owner = await sessions.lookup(kind, ref)
      return owner && !isStartPromptRequest(owner) ? owner : null
    } catch (e) {
      log('answerRouter: message lookup failed:', e)
      return null
    }
  }

  // A post, not a reply: a reply would settle an answer still streaming.
  async function tell(adapter: ChannelAdapter, text: string, meta?: InboundMeta): Promise<void> {
    await adapter
      .post(adapter.formatMarkdown(text), meta)
      .catch((e: unknown) => log('answerRouter: confirmation failed:', e))
  }

  async function deliver(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    owner: SessionMessageOwner,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<void> {
    const target: AnswerTarget | null =
      'deletedSession' in owner
        ? null
        : { sessionRef: owner.sessionRef, harnessSessionId: owner.harnessSessionId }
    if (!(await replyReachable({ copy, tell }, sessions, adapter, target, meta)) || !target) return
    if (sessions.usesRealShell(target)) {
      const title = sessions.label(target)
      return tell(adapter, fillTemplate(copy().realShell, { title }), meta)
    }
    const prompt = await attachedPrompt({ copy, tell }, sessions, adapter, target, msg, meta)
    if (prompt === null) return
    const origin = inboundOrigin(adapter.kind, msg)
    await submit(sessions, { adapter, target, message: { text: prompt }, origin, meta })
  }

  function liveTrialRun(sessions: SessionPort, owner: TrialRunMessageOwner): TrialRunOwner | null {
    return isTrialRunOwner(owner) && sessions.trialRunLive(owner.harnessSessionId) ? owner : null
  }

  /** An Answer to a Trial Run runs as its Follow-up; one thrown away since takes nothing. */
  async function deliverToTrialRun(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    owner: TrialRunMessageOwner,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<void> {
    const live = liveTrialRun(sessions, owner)
    if (!live) return tell(adapter, copy().trialRunThrownAway, meta)
    const target: TrialRunTarget = { trialRunSessionId: live.harnessSessionId }
    const prompt = await attachedPrompt({ copy, tell }, sessions, adapter, target, msg, meta)
    if (prompt === null) return
    const origin = inboundOrigin(adapter.kind, msg)
    await submit(sessions, { adapter, target, message: { text: prompt }, origin, meta })
  }

  function channelSessions(sessions: SessionPort) {
    return createChannelSessions({
      port: sessions,
      pointers: deps.pointers,
      copy,
      tell,
      submit: (adapter, target, message, origin, meta) =>
        submit(sessions, { adapter, target, message, origin, meta }),
      attach: (adapter, target, msg, meta) =>
        attachedPrompt({ copy, tell }, sessions, adapter, target, msg, meta),
      log,
    })
  }

  function channelAgents(sessions: SessionPort) {
    const forSessions = channelSessions(sessions)
    return createChannelAgents({
      listStartable: () => sessions.listStartableAgents(),
      agentName: (agentId) => sessions.agentName(agentId),
      channelSession: (adapter, meta) => forSessions.currentOrNew(adapter, meta),
      start: (adapter, sessionRef, agent, origin, meta) =>
        submit(sessions, { adapter, target: { sessionRef }, agent, origin, meta }),
      askForPrompt: (adapter, sessionRef, agent, meta) =>
        startPrompts(sessions).ask(adapter, sessionRef, agent, meta),
      copy,
      tell,
      log,
    })
  }

  function startPrompts(sessions: SessionPort) {
    return createChannelStartPrompts({
      port: sessions,
      requests: startPromptRequests,
      copy,
      tell,
      attach: (adapter, target, msg, meta) =>
        attachedPrompt({ copy, tell }, sessions, adapter, target, msg, meta),
      start: (adapter, sessionRef, agent, origin, prompt, meta, settled) =>
        submit(sessions, { adapter, target: { sessionRef }, agent, prompt, origin, meta, settled }),
      log,
    })
  }

  /** The Session `/stop` is for: a Notification's it replies to, else the Channel Session. */
  async function stopTarget(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<string | null> {
    const owner = msg.replyTo ? await answered(sessions, adapter.kind, msg.replyTo) : null
    if (owner && isTrialRunMessage(owner)) {
      const wording = copy()
      const live = liveTrialRun(sessions, owner)
      await tell(adapter, live ? wording.stopTrialRun : wording.trialRunThrownAway, meta)
      return null
    }
    if (owner) {
      const target = 'deletedSession' in owner ? null : { sessionRef: owner.sessionRef }
      const reachable = await replyReachable({ copy, tell }, sessions, adapter, target, meta)
      return reachable && target ? target.sessionRef : null
    }
    const current = await channelSessions(sessions).current(adapter, meta)
    if (!current) await tell(adapter, copy().stopNoSession, meta)
    return current
  }

  function stopCommand(sessions: SessionPort): ChannelCommand {
    return {
      name: 'stop',
      usage: '/stop',
      describe: (wording) => wording.helpStop,
      run: async ({ adapter, msg, meta }) => {
        const sessionRef = await stopTarget(adapter, sessions, msg, meta)
        if (!sessionRef) return
        const wording = copy()
        const title = sessions.label({ sessionRef })
        const running = sessions.activity(sessionRef)
        if (running.kind === 'idle' && queue.size(sessionRef) === 0) {
          return tell(adapter, fillTemplate(wording.stopNothing, { title }), meta)
        }
        // Dropped first, so the stopped turn's settle has nothing left to run.
        const count = await dropQueue(
          sessions,
          laneOf(sessions, { sessionRef }),
          'stopped',
          adapter.kind,
        )
        const stopped = running.kind === 'idle' ? running : await sessions.stop(sessionRef)
        const what =
          stopped.kind === 'agent-run'
            ? fillTemplate(wording.stopAgentRun, {
                name: stopped.name,
                title,
                step: stopped.step,
                steps: stopped.steps,
              })
            : stopped.kind === 'turn'
              ? fillTemplate(wording.stopTurn, { title })
              : fillTemplate(wording.stopNothing, { title })
        await tell(adapter, `${what}\n${fillTemplate(wording.stopDropped, { count })}`, meta)
      },
    }
  }

  function helpCommand(commands: () => ChannelCommand[]): ChannelCommand {
    return {
      name: 'help',
      usage: '/help',
      describe: (wording) => wording.helpHelp,
      run: async ({ adapter, meta }) => {
        const wording = copy()
        const gesture = answerGesture(adapter.kind)
        const answering = gesture ? wording[GESTURE_WORDING[gesture].help] : null
        await tell(adapter, helpText(commands(), wording, answering), meta)
      },
    }
  }

  async function runCommand(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<boolean> {
    const parsed = parseCommand(msg.text ?? '')
    if (!parsed) return false
    listen(sessions)
    const commands: ChannelCommand[] = [
      ...channelSessions(sessions).commands,
      ...channelAgents(sessions).commands,
      stopCommand(sessions),
      helpCommand(() => commands),
    ]
    const command = commands.find((entry) => entry.name === parsed.name.toLowerCase())
    if (!command) {
      const unknown = fillTemplate(copy().unknownCommand, { command: `/${parsed.name}` })
      await tell(adapter, unknown, meta)
      return true
    }
    await command.run({ adapter, msg, meta, args: parsed.args })
    return true
  }

  async function runCallback(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<boolean> {
    const data = msg.callback ?? ''
    const callbacks = [...channelSessions(sessions).callbacks, ...channelAgents(sessions).callbacks]
    const callback = callbacks.find((entry) => data.startsWith(entry.prefix))
    if (!callback) return false
    await callback.run({ adapter, msg, meta }, data.slice(callback.prefix.length))
    return true
  }

  async function route(
    adapter: ChannelAdapter,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<void> {
    const sessions = deps.sessions()
    if (msg.callback) {
      if (msg.callback === ANSWER_CALLBACK) return
      if (sessions && (await runCallback(adapter, sessions, msg, meta))) return
      await deps.questions.handleInbound(adapter, msg, meta)
      return
    }
    if (!sessions) {
      log('answerRouter: a channel message arrived before Sessions were reachable', null)
      return
    }
    if (waitingForSpeech.has(adapter.kind)) {
      // A typed answer to the download question cannot wait behind that download.
      if (deps.questions.handleInbound(adapter, msg, meta)) return
      afterSpeech(adapter.kind, () => inbound(adapter, sessions, msg, meta, true))
      return
    }
    await inbound(adapter, sessions, msg, meta, false)
  }

  /** Runs `work` once the Channel's earlier messages are through, off the channel's poll loop. */
  function afterSpeech(kind: ChannelKind, work: () => Promise<void>): void {
    const next = (waitingForSpeech.get(kind) ?? Promise.resolve())
      .then(work)
      .catch((e: unknown) => log('answerRouter: a message behind a voice message failed:', e))
    waitingForSpeech.set(kind, next)
    void next.then(() => {
      if (waitingForSpeech.get(kind) === next) waitingForSpeech.delete(kind)
    })
  }

  /** Refuses files no Session takes and transcribes voice, then routes it like typed text. */
  async function inbound(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    meta: InboundMeta | undefined,
    waiting: boolean,
  ): Promise<void> {
    const refusal = fileRefusal(adapter.kind, msg, copy())
    if (refusal) return tell(adapter, refusal, meta)
    const { audio, ...rest } = msg
    if (!audio?.length || !deps.speech) return dispatch(adapter, sessions, rest, meta)
    const spoken = (clips: RemoteAudio[]) => byVoice(adapter, sessions, rest, clips, meta)
    const preparation = await deps.speech.prepare(adapter, meta)
    if (!('downloading' in preparation)) {
      if (preparation.ready) await spoken(audio)
      return
    }
    const { downloading } = preparation
    const finish = async () => {
      if (await downloading) await spoken(audio)
    }
    // A download can take minutes, and its question is answered through this very poll loop.
    if (waiting) await finish()
    else afterSpeech(adapter.kind, finish)
  }

  async function byVoice(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ): Promise<void> {
    const transcript = await deps.speech?.transcribe(adapter, audio, meta)
    if (transcript == null) return
    const text = [msg.text?.trim(), transcript.trim()].filter(Boolean).join(' ')
    if (!text) return tell(adapter, copy().noSpeech, meta)
    await dispatch(adapter, sessions, { ...msg, text, voice: true }, meta)
  }

  async function dispatch(
    adapter: ChannelAdapter,
    sessions: SessionPort,
    msg: InboundChannelMessage,
    meta?: InboundMeta,
  ): Promise<void> {
    if (await runCommand(adapter, sessions, msg, meta)) return
    if (await startPrompts(sessions).reply(adapter, msg, meta)) return
    if (msg.replyTo) {
      const owner = await answered(sessions, adapter.kind, msg.replyTo)
      if (owner && isTrialRunMessage(owner)) {
        await deliverToTrialRun(adapter, sessions, owner, msg, answerMeta(msg, meta))
        return
      }
      if (owner) {
        await deliver(adapter, sessions, owner, msg, answerMeta(msg, meta))
        return
      }
    }
    if (await deps.questions.handleInbound(adapter, msg, meta)) return
    await channelSessions(sessions).plainMessage(adapter, msg, meta)
  }

  return { route }
}

/** A Session busy with a turn, or held by an Agent Run, takes the message once that ends. */
function isBusy(reason: string): boolean {
  return reason === 'busy' || reason === 'task-locked'
}
