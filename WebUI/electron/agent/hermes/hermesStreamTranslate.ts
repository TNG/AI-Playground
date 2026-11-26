import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import {
  createStreamTranslator,
  type StepUsage,
  type StreamChunk,
  type TurnSummary,
} from '../piStreamTranslate.ts'
import { HERMES_AIPG_MCP_SERVER } from '../../adapters/backends/hermesConfig.ts'

// Hermes Runs API events are restated as the Pi session events the Agent Mode translator already
// understands, so a Hermes turn reaches the renderer as the same UI message chunks a Pi turn does.

/** One `data:` payload of `GET /v1/runs/{id}/events`. */
export type HermesRunEvent = {
  event: string
  [key: string]: unknown
}

export type HermesUsage = { input_tokens?: number; output_tokens?: number; total_tokens?: number }

export type HermesStreamTranslatorOptions = {
  emit: (chunk: StreamChunk) => void
  model?: string
  turnId?: string
  /** AIPG's own tools, as Hermes names them, mapped back to the names the renderer renders. */
  aipgToolNames?: readonly string[]
  /** The full result of an AIPG tool call Hermes made, which its stream only previews. */
  takeAipgResult?: (toolName: string) => unknown
  onApprovalRequest?: (event: HermesRunEvent) => void
}

export type HermesStreamTranslator = {
  handle: (event: HermesRunEvent) => void
  /** The latest model call's token counts; its prompt plus reply is what the window holds. */
  stepUsage: (step: StepUsage, contextWindow?: number) => void
  notice: (text: string) => void
  /** Settles the stream from a terminal event; returns whether the event was terminal. */
  isTerminal: (event: HermesRunEvent) => boolean
  fail: (message: string) => void
  finish: () => void
}

const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'])
const MCP_PREFIX = `mcp__${HERMES_AIPG_MCP_SERVER}__`

export function aipgToolNameOf(hermesName: string, known: readonly string[]): string | undefined {
  if (!hermesName.toLowerCase().startsWith(MCP_PREFIX)) return undefined
  const bare = hermesName.slice(MCP_PREFIX.length).toLowerCase()
  return known.find((name) => name.toLowerCase() === bare)
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

export function createHermesStreamTranslator(
  options: HermesStreamTranslatorOptions,
): HermesStreamTranslator {
  const pi = createStreamTranslator({
    // Stamped so the timeline can withhold Regenerate and Delete, which rewind a Pi session.
    emit: (chunk) =>
      options.emit(
        chunk.type === 'start'
          ? {
              ...chunk,
              messageMetadata: {
                ...(chunk.messageMetadata as Record<string, unknown> | undefined),
                harness: 'hermes',
              },
            }
          : chunk,
      ),
    model: options.model,
    turnId: options.turnId,
  })
  const send = (event: Record<string, unknown>) => pi.handle(event as unknown as AgentSessionEvent)
  const known = () => options.aipgToolNames ?? []
  const toolNames = new Map<string, string>()
  let toolCount = 0
  let streamedText = false
  let messageOpen = false
  let usage: HermesUsage | undefined
  let occupancy: Pick<TurnSummary, 'lastStep' | 'contextUsage'> = {}

  const openMessage = () => {
    if (messageOpen) return
    messageOpen = true
    send({ type: 'message_start' })
  }
  const closeMessage = () => {
    if (!messageOpen) return
    messageOpen = false
    send({ type: 'message_end' })
  }
  const assistant = (type: string, delta: string) => {
    openMessage()
    send({
      type: 'message_update',
      assistantMessageEvent: { type, contentIndex: type.startsWith('thinking') ? 0 : 1, delta },
    })
  }

  send({ type: 'agent_start' })
  send({ type: 'turn_start' })

  function handle(event: HermesRunEvent): void {
    switch (event.event) {
      case 'message.delta': {
        const delta = str(event.delta)
        if (!delta) return
        streamedText = true
        assistant('text_delta', delta)
        return
      }
      case 'message.interim':
        if (event.already_streamed === true || !str(event.text)) return
        streamedText = true
        assistant('text_delta', str(event.text))
        return
      case 'reasoning.available':
      case 'reasoning.delta': {
        const text = str(event.text) || str(event.delta)
        if (text) assistant('thinking_delta', text)
        return
      }
      case 'tool.started': {
        closeMessage()
        const hermesName = str(event.tool) || 'tool'
        const toolName = aipgToolNameOf(hermesName, known()) ?? hermesName
        const toolCallId = str(event.tool_call_id) || `hermes-tool-${(toolCount += 1)}`
        toolNames.set(toolCallId, toolName)
        send({
          type: 'tool_execution_start',
          toolCallId,
          toolName,
          args: str(event.preview) ? { preview: str(event.preview) } : {},
        })
        return
      }
      case 'tool.completed': {
        const toolCallId =
          str(event.tool_call_id) ||
          [...toolNames.keys()].find((id) => id.startsWith('hermes-tool-')) ||
          ''
        const toolName = toolNames.get(toolCallId) ?? str(event.tool)
        toolNames.delete(toolCallId)
        const isError = event.error === true
        const aipgResult = known().includes(toolName)
          ? options.takeAipgResult?.(toolName)
          : undefined
        const duration = typeof event.duration === 'number' ? event.duration : undefined
        const summary =
          str(event.preview) ||
          (isError ? 'Tool failed.' : `Done${duration !== undefined ? ` in ${duration}s` : ''}.`)
        send({
          type: 'tool_execution_end',
          toolCallId,
          toolName,
          isError,
          result: aipgResult ?? { content: [{ type: 'text', text: summary }] },
        })
        return
      }
      case 'approval.request':
        options.onApprovalRequest?.(event)
        return
      case 'run.completed': {
        const output = str(event.output)
        if (!streamedText && output) assistant('text_delta', output)
        closeMessage()
        usage = (event.usage as HermesUsage | undefined) ?? undefined
        return
      }
      default:
        return
    }
  }

  function isTerminal(event: HermesRunEvent): boolean {
    return TERMINAL.has(event.event)
  }

  function stepUsage(step: StepUsage, contextWindow?: number): void {
    const tokens = step.inputTokens + step.outputTokens
    occupancy = {
      lastStep: step,
      ...(contextWindow
        ? {
            contextUsage: {
              tokens,
              contextWindow,
              percent: Math.min(100, (tokens / contextWindow) * 100),
            },
          }
        : {}),
    }
    pi.update(occupancy)
  }

  function finish(): void {
    closeMessage()
    pi.finish({
      ...(usage
        ? { usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } }
        : {}),
      ...occupancy,
    })
  }

  return {
    handle,
    stepUsage,
    notice: (text) => {
      closeMessage()
      pi.notice(text)
    },
    isTerminal,
    fail: (message) => {
      closeMessage()
      pi.fail(message)
    },
    finish,
  }
}

/** Splits an SSE byte stream into the JSON payloads of its `data:` lines. */
export async function* readSseEvents(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<HermesRunEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary: number
    while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '')
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      try {
        yield JSON.parse(data) as HermesRunEvent
      } catch {
        // a non-JSON data line carries nothing we render
      }
    }
  }
}
