import { AsyncLocalStorage } from 'node:async_hooks'
import { appLoggerInstance } from '../observability/logger.ts'
import type { LlamaCppTimings } from '../chat/turnEngine.ts'
import {
  recordAgentCallStats,
  type InferenceCallStats,
} from '../observability/laminarAttributes.ts'

// ── Agent-model HTTP: occupancy + optional timings ───────────────────────────
//
// Pi talks to the LLM with its own fetch, not the AI SDK wrapper in
// chatModelMain, so the GPU idle wait would otherwise stop llama-server
// mid-token. This wrapper counts matching local calls from dispatch until the
// body is drained (same lifetime as chatInferenceStreamsActive).
//
// Timings are read off calls to the endpoint this session registered, for the
// metrics footer of the turn that made the call and for Laminar.

const logger = appLoggerInstance
const LOG_SOURCE = 'laminar'

/** Enough to hold the final SSE event, which carries usage and timings. */
const TAIL_LIMIT = 16_384

let installed = false
let innerFetch: typeof fetch | null = null
let occupancyEndpoint: (() => string) | null = null
let timingsEndpoint: (() => string) | null = null
let timingsEnabled = false
let activeCalls = 0
const turnCalls = new AsyncLocalStorage<LlamaCppTimings[]>()

/** Runs one turn's model calls, collecting each call's timings into `calls`. */
export function collectAgentCallTimings<T>(
  calls: LlamaCppTimings[],
  work: () => Promise<T>,
): Promise<T> {
  return turnCalls.run(calls, work)
}

/**
 * A turn's calls in the shape of a chat answer's timings: generation summed over
 * every call, and the first call's prefill as the time to the first token.
 */
export function turnTimings(calls: LlamaCppTimings[]): LlamaCppTimings | undefined {
  const first = calls[0]
  if (!first) return undefined
  const sum = (key: keyof LlamaCppTimings) => calls.reduce((total, call) => total + call[key], 0)
  const promptN = sum('prompt_n')
  const promptMs = sum('prompt_ms')
  return {
    ...rates(promptN, promptMs, sum('predicted_n'), sum('predicted_ms')),
    cache_n: sum('cache_n'),
    prompt_ms: first.prompt_ms,
  }
}

function rates(
  promptN: number,
  promptMs: number,
  predictedN: number,
  predictedMs: number,
): LlamaCppTimings {
  return {
    cache_n: 0,
    prompt_n: promptN,
    prompt_ms: promptMs,
    prompt_per_token_ms: promptN > 0 ? promptMs / promptN : 0,
    prompt_per_second: promptMs > 0 ? (promptN / promptMs) * 1000 : 0,
    predicted_n: predictedN,
    predicted_ms: predictedMs,
    predicted_per_token_ms: predictedN > 0 ? predictedMs / predictedN : 0,
    predicted_per_second: predictedMs > 0 ? (predictedN / predictedMs) * 1000 : 0,
  }
}

export function piAgentCallsActive(): number {
  return activeCalls
}

/**
 * Count in-flight Pi calls to this local endpoint toward the GPU idle wait.
 * Idempotent; a later call re-points it at the model the next session runs on.
 */
export function trackAgentModelCalls(endpoint: () => string): void {
  occupancyEndpoint = endpoint
  install()
}

/**
 * Watch model calls to the agent's registered provider endpoint and report each
 * one's speeds. Idempotent; a later call re-points it at the endpoint of the
 * model the next session runs on.
 *
 * The endpoint is asked for per request rather than kept, because a local LLM
 * server relaunched mid-turn comes back on another port (see `localBaseUrl` in
 * piAgentManager.ts) — a remembered prefix would stop matching and every step
 * after the relaunch would lose its speeds.
 */
export function observeAgentModelCalls(endpoint: () => string): void {
  timingsEndpoint = endpoint
  timingsEnabled = true
  install()
}

export function resetAgentModelCallTrackingForTest(): void {
  if (innerFetch) {
    globalThis.fetch = innerFetch
    innerFetch = null
  }
  installed = false
  occupancyEndpoint = null
  timingsEndpoint = null
  timingsEnabled = false
  activeCalls = 0
}

function matches(endpoint: (() => string) | null, url: string): boolean {
  const prefix = endpoint?.().replace(/\/+$/, '')
  return Boolean(prefix && url.startsWith(prefix))
}

function beginOccupancy(): void {
  activeCalls++
}

function endOccupancy(): void {
  if (activeCalls > 0) activeCalls--
}

function install(): void {
  if (installed) return
  installed = true
  innerFetch = globalThis.fetch
  const original = innerFetch
  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input)
    const occupancy = matches(occupancyEndpoint, url)
    const timings = timingsEnabled && matches(timingsEndpoint, url)
    if (!occupancy && !timings) return original(input, init)

    if (occupancy) beginOccupancy()
    const calls = turnCalls.getStore()
    const startedAt = Date.now()
    try {
      const response = await original(input, init)
      try {
        const timeThis = timings && response.ok && Boolean(response.body)
        if (!occupancy && !timeThis) return response
        return wrapAgentResponse(response, { occupancy, timings: timeThis, startedAt, calls })
      } catch (error) {
        logger.warn(`could not observe a model call: ${error}`, LOG_SOURCE)
        if (occupancy) endOccupancy()
        return response
      }
    } catch (error) {
      if (occupancy) endOccupancy()
      throw error
    }
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function wrapAgentResponse(
  response: Response,
  opts: { occupancy: boolean; timings: boolean; startedAt: number; calls?: LlamaCppTimings[] },
): Response {
  if (!response.body) {
    if (opts.occupancy) endOccupancy()
    return response
  }
  let settled = false
  const settle = () => {
    if (settled) return
    settled = true
    if (opts.occupancy) endOccupancy()
  }
  let firstChunkAt = 0
  let tail = ''
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  const tracked = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          if (opts.timings) {
            const timings = summarize(tail, opts.startedAt, firstChunkAt, Date.now())
            if (timings) {
              opts.calls?.push(timings)
              recordAgentCallStats(callStats(timings))
            }
          }
          settle()
          controller.close()
          return
        }
        if (!firstChunkAt) firstChunkAt = Date.now()
        if (opts.timings && value) {
          tail = (tail + decoder.decode(value, { stream: true })).slice(-TAIL_LIMIT)
        }
        if (value) controller.enqueue(value)
      } catch (error) {
        settle()
        controller.error(error)
      }
    },
    cancel(reason) {
      settle()
      return reader.cancel(reason)
    },
  })
  return new Response(tracked, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

type FinalChunk = {
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  timings?: Partial<LlamaCppTimings>
}

function callStats(timings: LlamaCppTimings): InferenceCallStats {
  return {
    prefillTokensPerSecond: timings.prompt_per_second,
    generationTokensPerSecond: timings.predicted_per_second,
    promptMs: timings.prompt_ms,
    predictedMs: timings.predicted_ms,
    cacheTokens: timings.cache_n,
  }
}

/**
 * llama.cpp's own numbers when it sent them (it separates prefill from
 * generation and reports the prompt cache hit); otherwise the same split
 * measured from the outside — prompt tokens over the wait for the first byte,
 * completion tokens over the rest.
 */
function summarize(
  tail: string,
  startedAt: number,
  firstChunkAt: number,
  endedAt: number,
): LlamaCppTimings | null {
  const final = lastEvent(tail)
  if (!final) return null
  const own = final.timings
  if (own?.predicted_per_second !== undefined) {
    return {
      cache_n: own.cache_n ?? 0,
      prompt_n: own.prompt_n ?? final.usage?.prompt_tokens ?? 0,
      prompt_ms: own.prompt_ms ?? 0,
      prompt_per_token_ms: own.prompt_per_token_ms ?? 0,
      prompt_per_second: own.prompt_per_second ?? 0,
      predicted_n: own.predicted_n ?? final.usage?.completion_tokens ?? 0,
      predicted_ms: own.predicted_ms ?? 0,
      predicted_per_token_ms: own.predicted_per_token_ms ?? 0,
      predicted_per_second: own.predicted_per_second,
    }
  }
  if (!final.usage || !firstChunkAt) return null
  return rates(
    final.usage.prompt_tokens ?? 0,
    firstChunkAt - startedAt,
    final.usage.completion_tokens ?? 0,
    endedAt - firstChunkAt,
  )
}

/** The last SSE event in the tail that parses as JSON — `[DONE]` does not. */
function lastEvent(tail: string): FinalChunk | null {
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload.startsWith('{')) continue
    try {
      return JSON.parse(payload) as FinalChunk
    } catch {
      // A truncated first line of the tail: keep looking further back.
    }
  }
  return null
}
