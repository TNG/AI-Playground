import { appLoggerInstance } from './logging/logger.ts'
import { llmServerSnapshot, type LocalLlmBackend } from './llmServerSnapshot.ts'

// ── What a trace has to say about the turn that produced it ──────────────────
//
// Token counts and durations are on every LLM span already; what Laminar cannot
// know is which of our backends served the turn, on what device, with which
// build and command line, whether it was thinking, and how fast it actually ran
// (prefill and generation are different numbers, and only the server can tell
// them apart). None of that has an official OpenTelemetry key, so it goes on as
// trace metadata (filterable on the Traces page) plus `aipg.*` span attributes.
//
// Both surfaces converge here. Neither can call `Laminar.setSpanAttributes()`:
// that writes to the span on the OTel *context*, and neither the Pi extension
// nor Laminar's AI SDK integration ever puts its spans there (the integration's
// own source says so — they are parked in a map). What both do is create and
// end their spans through the SDK's tracer, so a span processor sees every one
// of them. `stampSpanStart` / `stampSpanEnd` are that processor's hooks; the
// context they read is set per agent run (main) or per chat turn (renderer, via
// the telemetry IPC).

const logger = appLoggerInstance
const LOG_SOURCE = 'laminar'

/** Laminar's wire format for trace metadata; the Traces page filters on these. */
const METADATA_PREFIX = 'lmnr.association.properties.metadata.'
const SPAN_TYPE = 'lmnr.span.type'

export type InferenceBackend = LocalLlmBackend | 'cloud'

/** The turn's setup, as far as the surface running it knows. */
export type InferenceTraceContext = {
  backend?: InferenceBackend
  /** Device the local backend is set to (`GPU.0`, `NPU`, …). */
  device?: string
  /** Provider id a cloud turn is routed to. */
  cloudProvider?: string
  /** Whether the model was told to think (`chat_template_kwargs.enable_thinking`). */
  thinking?: boolean
  /** Reasoning depth, for templates that read `reasoning_effort`. */
  reasoningEffort?: string
  /** Sampling that rides the request, under the OTel `gen_ai.request.*` names. */
  sampling?: { temperature?: number; topP?: number; maxTokens?: number }
}

/** How fast one model call actually ran. */
export type InferenceCallStats = {
  prefillTokensPerSecond?: number
  generationTokensPerSecond?: number
  promptMs?: number
  predictedMs?: number
  /** Prompt tokens served from the server's prefix cache (llama.cpp only). */
  cacheTokens?: number
}

type SpanAttributes = Record<string, string | number | boolean>

/**
 * Structural view of the span a processor is handed. Deliberately not typed
 * against `@opentelemetry/api`: the SDK is a devDependency loaded dynamically,
 * and all this needs is a name, a parent and an attribute bag.
 */
type ProcessedSpan = {
  name?: string
  attributes?: Record<string, unknown>
  parentSpanId?: string
  parentSpanContext?: { spanId?: string }
  isRecording?: () => boolean
  setAttribute?: (key: string, value: string | number | boolean) => unknown
}

// ── The two surfaces' contexts ───────────────────────────────────────────────
//
// The agent's is a getter, because thinking can be switched off in the middle
// of a run (planningPhase.ts) and the span that follows should say so. The
// chat's is a value the renderer pushes before its turn starts.

let agentContext: (() => InferenceTraceContext | undefined) | null = null
let chatContext: InferenceTraceContext | null = null
let agentCallStats: InferenceCallStats | null = null
let chatCallStats: InferenceCallStats | null = null

export function setAgentTraceContext(get: () => InferenceTraceContext | undefined): void {
  agentContext = get
}

export function clearAgentTraceContext(): void {
  agentContext = null
  agentCallStats = null
}

export function setChatTraceContext(context: InferenceTraceContext | null): void {
  chatContext = context
}

/**
 * The numbers of the model call that just finished. Read by the next LLM span
 * that ends, which is that same call's — both surfaces end the span from the
 * code path that has already consumed the whole response.
 */
export function recordAgentCallStats(stats: InferenceCallStats): void {
  agentCallStats = stats
}

export function recordChatCallStats(stats: InferenceCallStats | null): void {
  chatCallStats = stats
}

// ── Span processor hooks ─────────────────────────────────────────────────────

/**
 * Chat spans come from Laminar's AI SDK integration, which names every one of
 * them `ai.<operation>`; agent spans come from the Pi extension (`pi agent run`,
 * `LLM call (turn N)`, tool names). One trace never mixes the two.
 */
function isChatSpan(span: ProcessedSpan): boolean {
  return (span.name ?? '').startsWith('ai.')
}

function isRootSpan(span: ProcessedSpan): boolean {
  return !span.parentSpanId && !span.parentSpanContext?.spanId
}

function contextFor(span: ProcessedSpan): InferenceTraceContext | undefined {
  return isChatSpan(span) ? (chatContext ?? undefined) : agentContext?.()
}

/**
 * Trace-wide facts, on the root span where Laminar reads a trace's metadata.
 * Pi's spans are all parentless at start (it links them by path attributes
 * afterwards), so an agent run carries them on every span and a chat turn on
 * `ai.streamText` alone — the Traces page is happy either way.
 */
export function stampSpanStart(started: unknown): void {
  try {
    const span = started as ProcessedSpan
    if (!isRootSpan(span)) return
    const context = contextFor(span)
    if (!context) return
    const local =
      context.backend && context.backend !== 'cloud' ? llmServerSnapshot(context.backend) : {}
    apply(span, {
      ...optional(`${METADATA_PREFIX}backend`, context.backend),
      ...optional(`${METADATA_PREFIX}device`, context.device ?? local.device),
      ...optional(`${METADATA_PREFIX}cloudProvider`, context.cloudProvider),
      ...optional(`${METADATA_PREFIX}backendVersion`, local.backendVersion),
      ...optional(`${METADATA_PREFIX}serverArgs`, local.serverArgs),
    })
  } catch (error) {
    logger.warn(`could not stamp trace metadata: ${error}`, LOG_SOURCE)
  }
}

/**
 * Per-call facts, on the LLM span. Everything is known by the time it ends —
 * including the speeds, which only exist once the response has been read — and
 * an ended span is the one place both surfaces reliably pass through.
 */
export function stampSpanEnd(ended: unknown): void {
  try {
    const span = ended as ProcessedSpan
    if (span.attributes?.[SPAN_TYPE] !== 'LLM') return
    const chat = isChatSpan(span)
    const context = chat ? chatContext : agentContext?.()
    const stats = chat ? chatCallStats : agentCallStats
    if (chat) chatCallStats = null
    else agentCallStats = null
    apply(span, { ...requestAttributes(context), ...statsAttributes(stats) })
  } catch (error) {
    logger.warn(`could not stamp LLM span: ${error}`, LOG_SOURCE)
  }
}

function requestAttributes(context: InferenceTraceContext | null | undefined): SpanAttributes {
  if (!context) return {}
  return {
    ...optional('aipg.thinking', context.thinking),
    ...optional('aipg.reasoning_effort', context.reasoningEffort),
    ...optional('gen_ai.request.temperature', context.sampling?.temperature),
    ...optional('gen_ai.request.top_p', context.sampling?.topP),
    ...optional('gen_ai.request.max_tokens', context.sampling?.maxTokens),
  }
}

function statsAttributes(stats: InferenceCallStats | null | undefined): SpanAttributes {
  if (!stats) return {}
  return {
    ...optional('aipg.prefill_tokens_per_second', stats.prefillTokensPerSecond),
    ...optional('aipg.generation_tokens_per_second', stats.generationTokensPerSecond),
    ...optional('aipg.prompt_ms', stats.promptMs),
    ...optional('aipg.predicted_ms', stats.predictedMs),
    ...optional('aipg.cache_n', stats.cacheTokens),
  }
}

function optional(key: string, value: string | number | boolean | undefined): SpanAttributes {
  return value === undefined ? {} : { [key]: value }
}

/**
 * A recording span takes attributes through the SDK; an ended one has to be
 * written to directly, since `setAttribute` is a no-op (with a warning) after
 * `end()`. The exporter reads the same bag, and a processor is called before
 * the span is queued, so the late write still ships.
 */
function apply(span: ProcessedSpan, attributes: SpanAttributes): void {
  const entries = Object.entries(attributes)
  if (entries.length === 0) return
  const recording = span.isRecording?.() === true && typeof span.setAttribute === 'function'
  for (const [key, value] of entries) {
    if (recording) span.setAttribute?.(key, value)
    else if (span.attributes) span.attributes[key] = value
  }
}
