// ── The orchestrator (docs/architecture-target.md §4.4, steps 7 + 10) ─────────
//
// One queue and one GPU policy for every GPU-competing caller. Until this
// module existed the same job was smeared across three places that could not
// see each other: the renderer's mediaPipeline lanes (serializing tool calls),
// the renderer's chatBackends wrap (stopping/reloading the LLM around chat
// tool generations — and nothing did it for panel runs at all), and the
// gpuOccupancy refcount (the same wrap for in-process agent tools only).
//
// What it owns now:
// - the typed queue (`KernelRequestMap`): text turns (chat occupancy) and
//   artifact runs, plus a request lane for whole media-request brackets.
//   Artifact `queue` submissions (media nested in a turn) park FIFO on the
//   artifact queue; panel and Home Agent runs (`turn`) are Turn Queue members.
//   Queue lifecycle crosses the kernel bus as `queue-event`.
// - the GPU window: which side holds the GPU, the LLM⇄ComfyUI swap, the
//   skip-when-queued rule (a spritesheet costs one swap, not one per sprite),
//   and the wait for open chat HTTP (and unrelated text occupancy) before
//   stopping a backend mid-stream — no proceed-anyway bound.
// - chat readiness admission: Chat, Agent, and Home Agent `/load` occupy as
//   `text` requests first; `ensureChatBackendReady` then loads with
//   `skipGpuAdmission` because the window wait already happened.
//
// - the Turn Queue: text requests that `joinsTurnQueue` (agent turns, local and
//   cloud; local Chat and Home Agent turns; title summaries) and panel / Home
//   Agent media runs hold one exclusive place for their whole turn and wait FIFO
//   for it. Cloud Chat / Home Agent turns stay outside it. Media nested in the
//   holder's turn runs within it (same conversation key); members still waiting
//   never block it. Waiting members
//   carry their 1-based position and the holder's kind of work on `queue-event`
//   (`enqueued`, then `moved` whenever one ahead leaves).
//
// What deliberately stays out: which model to load is still data from the last
// successful load (or the turn request); download consent stays renderer-side.
// Text requests outside the Turn Queue stay concurrent with each other; they
// serialize only against the media GPU window. VRAM budgets / jump-the-queue
// are not here.

import { appLoggerInstance } from '../observability/logger'
import { emitArtifactPhase, emitQueueEvent } from './kernelBus'
import type { TurnWork } from '@/types/kernelEvents'
import {
  artifactRunActive,
  artifactRunTag,
  activeArtifactRunId,
  cancelActiveArtifactRun,
  startArtifactRun,
  type ArtifactRunPayload,
  type ArtifactRunResult,
} from '../artifact/runner'

const appLogger = appLoggerInstance

export type TextRequest = {
  runId: string
  conversationKey: string
  /** Local LLM turns wait for the chat GPU window. Cloud turns occupy without waiting. */
  needsGpu: boolean
  /**
   * Waits FIFO for the Turn Queue's one place and holds it until finished. Set by
   * the kind of work, not by GPU use: agent turns join even when cloud.
   */
  joinsTurnQueue?: boolean
  /** Lets a waiting member say what it waits for. */
  work?: TurnWork
}

export type KernelRequestMap = {
  text: { request: TextRequest; result: void }
  artifact: { request: ArtifactRunPayload; result: ArtifactRunResult }
}

export type KernelRequest<K extends keyof KernelRequestMap> = {
  id: string
  kind: K
  payload: KernelRequestMap[K]['request']
}

type TextOccupancy = TextRequest & { phase: 'waiting' | 'running' }

export type OrchestratorDeps = {
  /** Stop the running chat LLM/embedding servers (OVMS keeps speech servers up). */
  stopChatForMedia(): Promise<void>
  /** Free ComfyUI memory and unload its models (no-op when it is not running). */
  freeComfyMemory(): Promise<void>
  /** Load the last chat model again (in-process; no-op if none was loaded). */
  restartChatBackend(): Promise<void>
  /** In-flight /v1/chat/completions requests (chat turns, media specialists, summarize). */
  chatRequestsOpen(): number
}

let orchestratorDeps: OrchestratorDeps | null = null

type QueuedRun = {
  payload: ArtifactRunPayload
  resolve: (result: ArtifactRunResult) => void
}

const runQueue: QueuedRun[] = []

// Admitted = executeRun has been entered and not yet settled. `artifactRunActive`
// only flips once the runner starts, which is after the GPU acquire can await,
// so fail-fast has to key off this or two panel submits in the same tick both
// enter executeRun and the second cancels the first inside the runner.
let admittedArtifactRuns = 0
const admittedCancels = new Map<string, AbortController>()

// The media-request lane: one whole `media` bracket (nested specialist + its
// generations) at a time — four parallel `media` tool calls must not prompt
// the model four at once, and the bracket's own LLM steps need the chat
// backend up, so it waits for the GPU window before starting.
type QueuedMediaRequest = {
  runKey: string
  conversationKey?: string
  abortSignal?: AbortSignal
  run: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}
const mediaRequestQueue: QueuedMediaRequest[] = []
let mediaRequestActive = false

// 'media' while any artifact run has swapped the LLM off the GPU, 'chat'
// otherwise. The swap-back is tracked separately so a new media run (or a
// chat readiness) never stops the backend while its reload is still in
// flight — the old wraps shared this hazard, the queue makes it reachable.
let gpuWindow: 'chat' | 'media' = 'chat'
let swapBackInFlight: Promise<void> | null = null

const textOccupancy = new Map<string, TextOccupancy>()

// The Turn Queue: at most one member holds the place; the rest wait in
// submission order, each with the callback that hands it the place.
let turnHolder: string | null = null
const turnQueue: Array<{ runId: string; take: () => void; drop: () => void }> = []
// Panel / Home Agent runs that are Turn Queue members, from submission until they
// settle, each with the abort that withdraws or cancels it.
const turnMemberRuns = new Map<string, AbortController>()

export function setOrchestratorDeps(deps: OrchestratorDeps): void {
  orchestratorDeps = deps
}

// Test seam.
export function resetOrchestratorForTest(): void {
  orchestratorDeps = null
  runQueue.splice(0)
  for (const cancel of admittedCancels.values()) cancel.abort()
  admittedCancels.clear()
  admittedArtifactRuns = 0
  for (const entry of mediaRequestQueue) {
    entry.reject(new Error('Orchestrator reset for test'))
  }
  mediaRequestQueue.splice(0)
  mediaRequestActive = false
  gpuWindow = 'chat'
  swapBackInFlight = null
  textOccupancy.clear()
  turnHolder = null
  for (const entry of turnQueue.splice(0)) entry.drop()
  turnMemberRuns.clear()
}

export function artifactRunsQueued(): number {
  return runQueue.length
}

/** Admitted, executing, or queued — the close policy asks. */
export function artifactWorkOpen(): boolean {
  return queueBusy() || turnMemberRuns.size > 0
}

export function mediaRequestsQueued(): number {
  return mediaRequestQueue.length
}

export function textRequestsOpen(): number {
  return textOccupancy.size
}

/** Artifact FIFO only — text occupancy must not live here or nested media deadlocks. */
function queueBusy(): boolean {
  return admittedArtifactRuns > 0 || artifactRunActive() || runQueue.length > 0
}

function textWaitingCount(): number {
  let count = 0
  for (const entry of textOccupancy.values()) {
    if (entry.phase === 'waiting') count += 1
  }
  return count
}

/** The member holding the Turn Queue's place, if any. */
export function turnQueueHolder(): string | null {
  return turnHolder
}

function unrelatedLocalTextOpen(conversationKey?: string): boolean {
  for (const entry of textOccupancy.values()) {
    if (!entry.needsGpu) continue
    // A member still waiting for its place has not touched the GPU; waiting on it
    // would deadlock the holder's own nested media.
    if (entry.joinsTurnQueue && turnHolder !== entry.runId) continue
    if (conversationKey && entry.conversationKey === conversationKey) continue
    return true
  }
  return false
}

// ── Artifact run queue ────────────────────────────────────────────────────────

/**
 * Submits a resolved run. `queue: 'turn'` (panel / Home Agent) joins the Turn
 * Queue: it waits FIFO with turns for the place and holds it while it runs.
 * `'queue'` (chat tool lanes, in-process agent tools) parks FIFO on the artifact
 * queue and may run nested inside its parent turn, never behind waiting members.
 */
export function submitArtifactRun(
  payload: ArtifactRunPayload,
  options: { queue: 'turn' | 'queue' } = { queue: 'turn' },
): Promise<ArtifactRunResult> {
  if (options.queue === 'turn') return runAsTurnMember(payload)
  if (queueBusy()) return enqueueRun(payload)
  return executeRun(payload)
}

function enqueueRun(payload: ArtifactRunPayload): Promise<ArtifactRunResult> {
  return new Promise<ArtifactRunResult>((resolve) => {
    runQueue.push({ payload, resolve })
    emitArtifactPhase(artifactRunTag(payload), 'queued')
    emitQueueEvent({
      runKey: payload.runId,
      kind: 'artifact',
      action: 'enqueued',
      queueDepth: runQueue.length - 1,
      origin: payload.origin,
      conversationKey: payload.conversationKey,
      activityId: payload.activityId,
    })
  })
}

async function runAsTurnMember(payload: ArtifactRunPayload): Promise<ArtifactRunResult> {
  const cancel = new AbortController()
  turnMemberRuns.set(payload.runId, cancel)
  const place = takeTurnPlace(payload.runId, cancel.signal)
  const position = turnQueuePosition(payload.runId)
  if (position !== undefined) {
    emitArtifactPhase(artifactRunTag(payload), 'queued')
    emitQueueEvent({
      runKey: payload.runId,
      kind: 'artifact',
      action: 'enqueued',
      queueDepth: turnQueue.length - position,
      position,
      ...turnQueueContext(payload.runId),
      origin: payload.origin,
      conversationKey: payload.conversationKey,
      activityId: payload.activityId,
    })
  }
  try {
    await place
  } catch {
    turnMemberRuns.delete(payload.runId)
    return settleUnstartedMember(payload)
  }
  if (cancel.signal.aborted) {
    turnMemberRuns.delete(payload.runId)
    leaveTurnQueue(payload.runId)
    const result = settleUnstartedMember(payload)
    await drainQueue()
    return result
  }
  // Media that is not a member (a cloud chat's tool) may still hold the artifact queue.
  return queueBusy() ? enqueueRun(payload) : executeRun(payload)
}

function settleUnstartedMember(payload: ArtifactRunPayload): ArtifactRunResult {
  const result = cancelledRun()
  emitArtifactPhase(artifactRunTag(payload), 'cancelled', undefined, result.error)
  emitArtifactFinished(payload)
  return result
}

/** Gives a member run's place to the next member once the run has settled. */
function releaseMemberPlace(runId: string): void {
  if (turnMemberRuns.delete(runId)) leaveTurnQueue(runId)
}

function executeRun(payload: ArtifactRunPayload): Promise<ArtifactRunResult> {
  const cancel = turnMemberRuns.get(payload.runId) ?? new AbortController()
  admittedCancels.set(payload.runId, cancel)
  admittedArtifactRuns += 1
  emitQueueEvent({
    runKey: payload.runId,
    kind: 'artifact',
    action: 'started',
    queueDepth: runQueue.length,
    origin: payload.origin,
    conversationKey: payload.conversationKey,
    activityId: payload.activityId,
  })
  return withGpuWindow(payload, () => startArtifactRun(payload), cancel.signal).finally(
    async () => {
      admittedCancels.delete(payload.runId)
      emitArtifactFinished(payload)
      admittedArtifactRuns -= 1
      // Before the drain, so its release can see a member run taking the place next.
      releaseMemberPlace(payload.runId)
      await drainQueue()
    },
  )
}

async function drainQueue(): Promise<void> {
  if (admittedArtifactRuns > 0 || artifactRunActive()) return
  const next = runQueue.shift()
  if (next) {
    void executeRun(next.payload).then(next.resolve)
    return
  }
  // Release lives here, not in withGpuWindow: Keep Models Loaded skips acquire
  // but a queued keep-true tail after a swap still has to return the GPU to
  // chat, and cancelling the last waiter must not leave the window on media.
  await considerRelease()
}

function emitArtifactFinished(payload: ArtifactRunPayload): void {
  emitQueueEvent({
    runKey: payload.runId,
    kind: 'artifact',
    action: 'finished',
    queueDepth: runQueue.length,
    origin: payload.origin,
    conversationKey: payload.conversationKey,
    activityId: payload.activityId,
  })
}

/** Cancels one run by id, whether it is active, admitted, or still waiting. */
export function cancelArtifactRun(runId: string): void {
  admittedCancels.get(runId)?.abort()
  turnMemberRuns.get(runId)?.abort()
  if (activeArtifactRunId() === runId) {
    cancelActiveArtifactRun()
    return
  }
  const index = runQueue.findIndex((entry) => entry.payload.runId === runId)
  if (index !== -1) {
    const [entry] = runQueue.splice(index, 1)
    dropQueuedRun(entry)
  }
}

function dropQueuedRun(entry: (typeof runQueue)[number], reason?: string): void {
  const result = cancelledRun(reason)
  emitArtifactPhase(artifactRunTag(entry.payload), 'cancelled', undefined, result.error)
  emitArtifactFinished(entry.payload)
  releaseMemberPlace(entry.payload.runId)
  entry.resolve(result)
}

/**
 * Drops queued runs and aborts admitted/active ones. A destroyed renderer
 * cannot drive placeholders, and a replacement window must not fail-fast on
 * an invisible drain.
 */
export function cancelAllArtifactRuns(reason = 'Generation cancelled.'): void {
  for (const entry of runQueue.splice(0)) dropQueuedRun(entry, reason)
  for (const cancel of admittedCancels.values()) cancel.abort()
  for (const cancel of turnMemberRuns.values()) cancel.abort()
  cancelActiveArtifactRun()
}

function cancelledRun(error = 'Generation cancelled.'): ArtifactRunResult {
  return { state: 'cancelled', items: [], error }
}

// ── Text occupancy (`KernelRequestMap['text']`, step 10) ───────────────────────

/**
 * Registers a chat turn as queue occupancy and, for local LLM turns, waits
 * until the GPU window is chat. Resolves when the turn may load/stream.
 * Nested media for this conversation uses `queue`, not fail-fast, so it can
 * take the GPU while this occupancy is still live (HTTP is idle in the tool
 * phase). Cloud turns occupy without waiting — they do not hold the local GPU —
 * unless they join the Turn Queue, where every member first waits for its place.
 */
export async function submitTextRequest(request: TextRequest, signal?: AbortSignal): Promise<void> {
  if (textOccupancy.has(request.runId)) {
    throw new Error(`Text request ${request.runId} is already occupying the queue`)
  }
  textOccupancy.set(request.runId, { ...request, phase: 'waiting' })
  // Joined before announcing, so the enqueued event already carries its position.
  const place = request.joinsTurnQueue ? takeTurnPlace(request.runId, signal) : null
  emitQueueEvent({
    runKey: request.runId,
    kind: 'text',
    action: 'enqueued',
    queueDepth: Math.max(0, textWaitingCount() - 1),
    position: turnQueuePosition(request.runId),
    ...turnQueueContext(request.runId),
    conversationKey: request.conversationKey,
  })
  try {
    if (place) await place
    if (request.needsGpu) {
      await awaitChatWindow(signal)
    } else if (signal?.aborted) {
      throw cancelledChatWindow()
    }
    const entry = textOccupancy.get(request.runId)
    if (!entry) {
      leaveTurnQueue(request.runId)
      return
    }
    entry.phase = 'running'
    emitQueueEvent({
      runKey: request.runId,
      kind: 'text',
      action: 'started',
      queueDepth: textWaitingCount(),
      work: request.work,
      conversationKey: request.conversationKey,
    })
  } catch (error) {
    finishTextRequest(request.runId)
    throw error
  }
}

/** Drops occupancy. Idempotent — cancel-during-wait already finished it. */
export function finishTextRequest(runId: string): void {
  const entry = textOccupancy.get(runId)
  if (!entry) return
  textOccupancy.delete(runId)
  leaveTurnQueue(runId)
  emitQueueEvent({
    runKey: runId,
    kind: 'text',
    action: 'finished',
    queueDepth: textWaitingCount(),
    work: entry.work,
    conversationKey: entry.conversationKey,
  })
}

/**
 * Resolves once `runId` holds the Turn Queue's place: at once when it is free and
 * nobody is waiting, otherwise when every member submitted before it has finished.
 */
function takeTurnPlace(runId: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledTurnQueue())
  if (turnHolder === null && turnQueue.length === 0) {
    turnHolder = runId
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => leaveTurnQueue(runId)
    turnQueue.push({
      runId,
      take: () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      },
      drop: () => {
        signal?.removeEventListener('abort', onAbort)
        reject(cancelledTurnQueue())
      },
    })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Dequeues a waiting member (its wait rejects) or releases the place to the next one. */
function leaveTurnQueue(runId: string): void {
  const index = turnQueue.findIndex((entry) => entry.runId === runId)
  if (index !== -1) {
    turnQueue.splice(index, 1)[0].drop()
    announceTurnPositions(index)
  }
  if (turnHolder !== runId) return
  turnHolder = null
  const next = turnQueue.shift()
  if (!next) return
  turnHolder = next.runId
  next.take()
  announceTurnPositions(0)
}

/** 1-based place among waiting members; undefined for the holder or a non-member. */
function turnQueuePosition(runId: string): number | undefined {
  const index = turnQueue.findIndex((entry) => entry.runId === runId)
  return index === -1 ? undefined : index + 1
}

/** Every waiting member from `fromIndex` on has moved up one place. */
function announceTurnPositions(fromIndex: number): void {
  for (let index = fromIndex; index < turnQueue.length; index += 1) {
    const { runId } = turnQueue[index]
    emitQueueEvent({
      runKey: runId,
      kind: turnMemberRuns.has(runId) ? 'artifact' : 'text',
      action: 'moved',
      queueDepth: turnQueue.length - index - 1,
      position: index + 1,
      ...turnQueueContext(runId),
      conversationKey: textOccupancy.get(runId)?.conversationKey,
    })
  }
}

/** The member's own kind of work and, while it waits, the kind of work holding the place. */
function turnQueueContext(runId: string): { work?: TurnWork; holder?: TurnWork } {
  const waiting = turnQueuePosition(runId) !== undefined
  const holder = waiting ? turnHolder : null
  return { work: memberWork(runId), holder: holder ? memberWork(holder) : undefined }
}

function memberWork(runId: string): TurnWork | undefined {
  return turnMemberRuns.has(runId) ? 'generation' : textOccupancy.get(runId)?.work
}

function cancelledTurnQueue(): Error {
  return new Error('Cancelled while waiting in the Turn Queue.')
}

// ── Media request lane ─────────────────────────────────────────────────────────

/**
 * Runs one whole media-request bracket at a time, waiting for the GPU window
 * first: the bracket's own LLM steps need the chat backend, so it must not
 * start while a generation holds the GPU for media.
 */
export function runMediaRequest<T>(
  run: () => Promise<T>,
  options: { runKey: string; conversationKey?: string; abortSignal?: AbortSignal },
): Promise<T> {
  if (options.abortSignal?.aborted) {
    return Promise.reject(new Error('Cancelled while waiting for the media request lane.'))
  }
  return new Promise<T>((resolve, reject) => {
    const entry: QueuedMediaRequest = {
      runKey: options.runKey,
      conversationKey: options.conversationKey,
      abortSignal: options.abortSignal,
      run,
      resolve: resolve as (value: unknown) => void,
      reject,
    }
    const onAbort = () => {
      const index = mediaRequestQueue.indexOf(entry)
      if (index === -1) return
      mediaRequestQueue.splice(index, 1)
      emitQueueEvent({
        runKey: entry.runKey,
        kind: 'media-request',
        action: 'finished',
        queueDepth: mediaRequestQueue.length,
        conversationKey: entry.conversationKey,
      })
      reject(new Error('Cancelled while waiting for the media request lane.'))
    }
    options.abortSignal?.addEventListener('abort', onAbort, { once: true })
    mediaRequestQueue.push(entry)
    emitQueueEvent({
      runKey: options.runKey,
      kind: 'media-request',
      action: 'enqueued',
      queueDepth: mediaRequestQueue.length - 1,
      conversationKey: options.conversationKey,
    })
    drainMediaRequestLane()
  })
}

function drainMediaRequestLane(): void {
  if (mediaRequestActive) return
  const entry = mediaRequestQueue.shift()
  if (!entry) return
  mediaRequestActive = true
  void (async () => {
    try {
      if (entry.abortSignal?.aborted) {
        throw new Error('Cancelled while waiting for the media request lane.')
      }
      await waitForChatWindow(entry.abortSignal)
      if (entry.abortSignal?.aborted) {
        throw new Error('Cancelled while waiting for the media request lane.')
      }
      emitQueueEvent({
        runKey: entry.runKey,
        kind: 'media-request',
        action: 'started',
        queueDepth: mediaRequestQueue.length,
        conversationKey: entry.conversationKey,
      })
      const result = await entry.run()
      entry.resolve(result)
    } catch (error) {
      entry.reject(error)
    } finally {
      emitQueueEvent({
        runKey: entry.runKey,
        kind: 'media-request',
        action: 'finished',
        queueDepth: mediaRequestQueue.length,
        conversationKey: entry.conversationKey,
      })
      mediaRequestActive = false
      drainMediaRequestLane()
    }
  })()
}

// ── GPU window policy ──────────────────────────────────────────────────────────

/**
 * Brackets GPU-holding work. `keepModelsLoaded` skips the swap *onto* media
 * (the user's developer setting, carried per run) but never the swap back —
 * that lives in `drainQueue` so a keep-true tail after a real swap still
 * returns the GPU to chat. Failures in the swap-back are logged, never thrown
 * — throwing would replace a finished result with a cleanup error, and the
 * chat model comes back with the next turn anyway.
 */
async function withGpuWindow<T>(
  payload: ArtifactRunPayload,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    if (!payload.keepModelsLoaded) await acquireMediaWindow(payload.conversationKey, signal)
    if (signal?.aborted) return cancelledRun() as T
    return await fn()
  } catch (error) {
    if (signal?.aborted) return cancelledRun() as T
    throw error
  }
}

/** Reads the window without flow narrowing — an awaited swap-back can flip it. */
function windowIsMedia(): boolean {
  return gpuWindow === 'media'
}

async function acquireMediaWindow(conversationKey?: string, signal?: AbortSignal): Promise<void> {
  if (!orchestratorDeps) return
  if (windowIsMedia()) return
  // A release may still be reloading the chat backend; stopping it mid-reload
  // is the race the old wraps shared, and the queue makes it reachable.
  if (swapBackInFlight) await swapBackInFlight.catch(() => {})
  if (windowIsMedia()) return
  await waitForChatRequestsIdle(signal)
  // Nested media for this conversation may take the GPU while its parent text
  // occupancy is still live (tool phase, HTTP idle). An unrelated chat turn
  // must finish first — no proceed-anyway bound, or that stream dies as a
  // network error.
  await waitForUnrelatedTextIdle(conversationKey, signal)
  if (windowIsMedia()) return
  if (signal?.aborted) throw cancelledGeneration()
  // Flip before stopChatForMedia (seconds — two backends). awaitChatWindow is a
  // one-shot wait on this flag; leaving it on 'chat' until after the stop lets
  // a turn pass the gate and then die when the in-flight stop kills its backend.
  gpuWindow = 'media'
  try {
    await orchestratorDeps.stopChatForMedia()
  } catch (error) {
    gpuWindow = 'chat'
    throw error
  }
  if (signal?.aborted) throw cancelledGeneration()
}

const CHAT_REQUEST_POLL_MS = 250

async function waitForChatRequestsIdle(signal?: AbortSignal): Promise<void> {
  if (!orchestratorDeps) return
  while (orchestratorDeps.chatRequestsOpen() > 0) {
    if (signal?.aborted) throw cancelledGeneration()
    await delay(CHAT_REQUEST_POLL_MS, signal, cancelledGeneration)
  }
}

async function waitForUnrelatedTextIdle(
  conversationKey?: string,
  signal?: AbortSignal,
): Promise<void> {
  while (unrelatedLocalTextOpen(conversationKey)) {
    if (signal?.aborted) throw cancelledGeneration()
    await delay(CHAT_REQUEST_POLL_MS, signal, cancelledGeneration)
  }
}

/**
 * The skip rule: a run that still sees media work queued behind it (or a panel
 * run taking the Turn Queue's place next) leaves both models where they are and lets the last one out do the swap back — one
 * spritesheet costs one swap, not one per sprite. Queued media requests do
 * NOT skip it: their first LLM step needs the chat backend back.
 */
async function considerRelease(): Promise<void> {
  if (gpuWindow !== 'media') return
  if (runQueue.length > 0) return
  // A panel run has just taken the place and is about to need the GPU for media.
  if (turnHolder !== null && turnMemberRuns.has(turnHolder)) return
  if (!orchestratorDeps) return
  const deps = orchestratorDeps
  gpuWindow = 'chat'
  swapBackInFlight = (async () => {
    try {
      await deps.freeComfyMemory()
    } catch (error) {
      appLogger.warn(`Freeing image models failed: ${String(error)}`, 'electron-backend')
    }
    try {
      await deps.restartChatBackend()
    } catch (error) {
      appLogger.warn(
        `Could not load the chat model again after generating: ${String(error)}`,
        'electron-backend',
      )
    }
  })()
  try {
    await swapBackInFlight
  } finally {
    swapBackInFlight = null
  }
}

/**
 * Resolves once the GPU window is back on chat and no swap-back is running.
 * Chat, Agent, and Home Agent `/load` wait here via `submitTextRequest`.
 * No proceed-anyway bound: abort the signal (cancel the turn) to give up.
 */
export async function awaitChatWindow(signal?: AbortSignal): Promise<void> {
  while (gpuWindow === 'media' || swapBackInFlight) {
    if (signal?.aborted) throw cancelledChatWindow()
    await delay(500, signal)
  }
}

function waitForChatWindow(signal?: AbortSignal): Promise<void> {
  return awaitChatWindow(signal)
}

function cancelledChatWindow(): Error {
  return new Error('Cancelled while waiting for the chat GPU window.')
}

function cancelledGeneration(): Error {
  return new Error('Generation cancelled.')
}

function delay(
  ms: number,
  signal?: AbortSignal,
  abortedError: () => Error = cancelledChatWindow,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortedError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
