// ── The orchestrator (docs/architecture-target.md §4.4, step 7) ────────────────
//
// One queue and one GPU policy for every GPU-competing caller. Until this
// module existed the same job was smeared across three places that could not
// see each other: the renderer's mediaPipeline lanes (serializing tool calls),
// the renderer's chatBackends wrap (stopping/reloading the LLM around chat
// tool generations — and nothing did it for panel runs at all), and the
// gpuOccupancy refcount (the same wrap for in-process agent tools only).
//
// What it owns now:
// - the typed queue: artifact runs (any origin — panel, chat tools, Home
//   Agent, in-process agent tools) and whole media-request brackets. `queue`
//   submissions park FIFO; `fail-fast` keeps the panel's "one generation at a
//   time" contract. Queue lifecycle crosses the kernel bus as `queue-event`.
// - the GPU window: which side holds the GPU, the LLM⇄ComfyUI swap, the
//   skip-when-queued rule (a spritesheet costs one swap, not one per sprite),
//   and the wait for open chat requests before stopping a backend mid-stream.
// - chat readiness admission: a chat backend load asks for the window, so it
//   no longer races (or OOMs against) an active media run.
//
// What deliberately stays out: which model to load is renderer state (the
// reload round-trips through the artifact request RPC until step 8), and
// chat turns themselves never queue — they are concurrent by design and only
// their backend readiness is admitted here.

import { appLoggerInstance } from '../logging/logger'
import { emitQueueEvent } from '../kernel/kernelBus'
import {
  artifactRunActive,
  activeArtifactRunId,
  cancelActiveArtifactRun,
  startArtifactRun,
  type ArtifactRunPayload,
  type ArtifactRunResult,
} from '../artifact/runner'

const appLogger = appLoggerInstance

export type OrchestratorDeps = {
  /** Stop the running chat LLM/embedding servers (OVMS keeps speech servers up). */
  stopChatForMedia(): Promise<void>
  /** Free ComfyUI memory and unload its models (no-op when it is not running). */
  freeComfyMemory(): Promise<void>
  /** Load the chat model again — main asks the renderer, which owns model selection. */
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

export function setOrchestratorDeps(deps: OrchestratorDeps): void {
  orchestratorDeps = deps
}

// Test seam.
export function resetOrchestratorForTest(): void {
  orchestratorDeps = null
  runQueue.splice(0)
  for (const entry of mediaRequestQueue) {
    entry.reject(new Error('Orchestrator reset for test'))
  }
  mediaRequestQueue.splice(0)
  mediaRequestActive = false
  gpuWindow = 'chat'
  swapBackInFlight = null
}

export function artifactRunsQueued(): number {
  return runQueue.length
}

export function mediaRequestsQueued(): number {
  return mediaRequestQueue.length
}

/** Runs waiting behind the active one (media requests have their own lane). */
function queueBusy(): boolean {
  return artifactRunActive() || runQueue.length > 0
}

// ── Artifact run queue ────────────────────────────────────────────────────────

/**
 * Submits a resolved run. `queue: 'fail-fast'` (panel / Home Agent) refuses
 * while anything is executing or queued; `'queue'` (chat tool lanes,
 * in-process agent tools) parks FIFO behind the active run.
 */
export function submitArtifactRun(
  payload: ArtifactRunPayload,
  options: { queue: 'fail-fast' | 'queue' } = { queue: 'fail-fast' },
): Promise<ArtifactRunResult> {
  if (queueBusy()) {
    if (options.queue === 'fail-fast') {
      return Promise.resolve({
        state: 'failed',
        items: [],
        error: 'Another generation is already in progress',
      })
    }
    return new Promise<ArtifactRunResult>((resolve) => {
      runQueue.push({ payload, resolve })
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
  return executeRun(payload)
}

function executeRun(payload: ArtifactRunPayload): Promise<ArtifactRunResult> {
  emitQueueEvent({
    runKey: payload.runId,
    kind: 'artifact',
    action: 'started',
    queueDepth: runQueue.length,
    origin: payload.origin,
    conversationKey: payload.conversationKey,
    activityId: payload.activityId,
  })
  const settled = withGpuWindow(payload, () => startArtifactRun(payload)).finally(() => {
    emitQueueEvent({
      runKey: payload.runId,
      kind: 'artifact',
      action: 'finished',
      queueDepth: runQueue.length,
      origin: payload.origin,
      conversationKey: payload.conversationKey,
      activityId: payload.activityId,
    })
    dequeueNext()
  })
  return settled
}

function dequeueNext(): void {
  if (artifactRunActive()) return
  const next = runQueue.shift()
  if (!next) return
  void executeRun(next.payload).then(next.resolve)
}

/** Cancels one run by id, whether it is active or still waiting in the queue. */
export function cancelArtifactRun(runId: string): void {
  if (activeArtifactRunId() === runId) {
    cancelActiveArtifactRun()
    return
  }
  const index = runQueue.findIndex((entry) => entry.payload.runId === runId)
  if (index !== -1) {
    const [entry] = runQueue.splice(index, 1)
    entry.resolve({ state: 'cancelled', items: [], error: 'Generation cancelled.' })
  }
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
  return new Promise<T>((resolve, reject) => {
    const entry: QueuedMediaRequest = {
      runKey: options.runKey,
      conversationKey: options.conversationKey,
      abortSignal: options.abortSignal,
      run,
      resolve: resolve as (value: unknown) => void,
      reject,
    }
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
 * Brackets GPU-holding work. `keepModelsLoaded` is the user's developer
 * setting, carried per run: with it set nothing is ever swapped. Failures in
 * the swap-back are logged, never thrown — this runs where throwing would
 * replace a finished result with a cleanup error, and the chat model comes
 * back with the next turn anyway.
 */
async function withGpuWindow<T>(payload: ArtifactRunPayload, fn: () => Promise<T>): Promise<T> {
  if (payload.keepModelsLoaded) return fn()
  try {
    await acquireMediaWindow()
    return await fn()
  } finally {
    await considerRelease()
  }
}

/** Reads the window without flow narrowing — an awaited swap-back can flip it. */
function windowIsMedia(): boolean {
  return gpuWindow === 'media'
}

async function acquireMediaWindow(): Promise<void> {
  if (!orchestratorDeps) return
  if (windowIsMedia()) return
  // A release may still be reloading the chat backend; stopping it mid-reload
  // is the race the old wraps shared, and the queue makes it reachable.
  if (swapBackInFlight) await swapBackInFlight.catch(() => {})
  if (windowIsMedia()) return
  await waitForChatRequestsIdle()
  await orchestratorDeps.stopChatForMedia()
  gpuWindow = 'media'
}

// Bounded so a wedged stream cannot hang a generation indefinitely (the old
// renderer wrap capped this at 3s, which also fired on every chat-originated
// run — a turn in its tool phase counts as active but holds no open request).
const CHAT_REQUEST_WAIT_MS = 120_000
const CHAT_REQUEST_POLL_MS = 250

async function waitForChatRequestsIdle(): Promise<void> {
  if (!orchestratorDeps) return
  const start = Date.now()
  while (orchestratorDeps.chatRequestsOpen() > 0) {
    if (Date.now() - start >= CHAT_REQUEST_WAIT_MS) {
      appLogger.warn(
        'GPU swap proceeded while a chat request was still open (120s wait elapsed)',
        'electron-backend',
      )
      return
    }
    await delay(CHAT_REQUEST_POLL_MS)
  }
}

/**
 * The skip rule: a run that still sees media work queued behind it leaves both
 * models where they are and lets the last one out do the swap back — one
 * spritesheet costs one swap, not one per sprite. Queued media requests do
 * NOT skip it: their first LLM step needs the chat backend back.
 */
async function considerRelease(): Promise<void> {
  if (gpuWindow !== 'media') return
  if (runQueue.length > 0) return
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
 * Chat backend readiness (the `ensureBackendReadiness` handler) waits on this
 * so loading the LLM no longer races an active media run. Bounded: a long
 * video queue would otherwise hold a chat send hostage — after the bound the
 * load proceeds exactly as it did before the orchestrator existed.
 */
const CHAT_WINDOW_WAIT_MS = 300_000

export async function awaitChatWindow(signal?: AbortSignal): Promise<void> {
  const start = Date.now()
  while (gpuWindow === 'media' || swapBackInFlight) {
    if (signal?.aborted) throw new Error('Cancelled while waiting for the chat GPU window.')
    if (Date.now() - start >= CHAT_WINDOW_WAIT_MS) {
      appLogger.warn(
        'Chat readiness proceeded while media still held the GPU (5min wait elapsed)',
        'electron-backend',
      )
      return
    }
    await delay(500)
  }
}

function waitForChatWindow(signal?: AbortSignal): Promise<void> {
  return awaitChatWindow(signal)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
