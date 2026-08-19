import { laminarTelemetryActive, sendLaminarEvent } from './laminarTelemetry'

// ── Spans for renderer work that is not an LLM call ──────────────────────────
//
// A Game Maker `media` call lands in Laminar as one opaque TOOL span covering
// the whole IPC wait, because everything it does — starting ComfyUI, swapping
// the LLM off the GPU, downloading a checkpoint, running the workflow — happens
// here in the renderer. `@lmnr-ai/lmnr` still cannot run on this page (see
// laminarTelemetry.ts), so this follows the same pattern as chat telemetry:
// serialize start/end here, create the real spans in main
// (electron/laminarSpans.ts), which parents them under the open media TOOL span
// when there is one.
//
// Everything here is fire-and-forget and never throws: a missing span is worth
// less than the generation it would have described.

const SPAN_START_EVENT = 'aipgSpanStart'
const SPAN_END_EVENT = 'aipgSpanEnd'

export type TraceAttributes = Record<string, string | number | boolean | undefined>

export type TraceSpanOptions = {
  attributes?: TraceAttributes
  /** JSON-serializable description of what the span was asked to do. */
  input?: unknown
  /** Id of another span from this module. Defaults to the open media TOOL span. */
  parentId?: string
}

/**
 * A started span. `end()` is idempotent, so callers may settle it twice.
 *
 * Attributes set after the start (generation progress, say) travel with the end
 * event rather than as a stream of updates: a span reaches Laminar when it ends,
 * so an update per websocket tick would be IPC nobody ever reads.
 */
export type TraceSpan = {
  readonly id: string
  readonly name: string
  setAttributes(attributes: TraceAttributes): void
  end(result?: { output?: unknown; error?: unknown }): void
}

const INACTIVE: TraceSpan = {
  id: '',
  name: '',
  setAttributes: () => {},
  end: () => {},
}

let nextSpanId = 0

/**
 * Start a span that outlives the call that created it — a phase driven by
 * websocket events, or one whose end is decided by a state machine. Returns a
 * no-op handle when tracing is off.
 */
export function startTraceSpan(name: string, options: TraceSpanOptions = {}): TraceSpan {
  if (!laminarTelemetryActive()) return INACTIVE
  const id = `r${++nextSpanId}`
  sendLaminarEvent(SPAN_START_EVENT, {
    id,
    name,
    attributes: options.attributes,
    input: options.input,
    parentId: options.parentId,
  })
  let ended = false
  let late: TraceAttributes | undefined
  return {
    id,
    name,
    setAttributes: (attributes) => {
      late = { ...late, ...attributes }
    },
    end: (result) => {
      if (ended) return
      ended = true
      sendLaminarEvent(SPAN_END_EVENT, {
        id,
        attributes: late,
        output: result?.output,
        error: result?.error === undefined ? undefined : errorText(result.error),
      })
    },
  }
}

/** Span around one await. Records a failure, then rethrows it unchanged. */
export async function withTraceSpan<T>(
  name: string,
  run: () => Promise<T>,
  options: TraceSpanOptions = {},
): Promise<T> {
  const span = startTraceSpan(name, options)
  try {
    const result = await run()
    span.end()
    return result
  } catch (error) {
    span.end({ error })
    throw error
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
