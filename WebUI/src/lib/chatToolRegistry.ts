import { z, type ZodType } from 'zod'
import { convertToModelMessages, type ModelMessage, type ToolSet } from 'ai'
import { completeOrphanedToolParts, sanitizeBulkyToolOutputs } from '@/lib/toolMessageSanitize'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import type { ChatToolExecution, ChatToolResult, ChatToolSpec } from '@/types/chatIpc'

// ── Renderer-side chat tool execution (step 6: chat inference in main) ────────
//
// Tool bodies stay renderer-side by design (closures over Pinia stores, see
// architecture-target §8 step 6), while the turn engine in main owns the AI
// SDK call. The store serializes each turn's ToolSet into data (`ChatToolSpec`)
// that ships with the turn request; when main needs a tool body it sends a
// `chat:executeTool` payload and this registry runs the original execute()
// closure, reporting the result back over `chat:toolResult`.
//
// Because the specs cross the boundary as plain JSON Schema, main cannot
// validate tool-call input the way the old zod ToolSet did — so the renderer
// executor validates against the original zod schema here instead. A failure
// throws before the tool runs, which main surfaces to the model as an error
// tool result — the same shape the SDK produced when its own validation
// rejected the input (except the comfy workflow repair, which main handles
// from the shipped repairData before this point).

type ToolExecutor = (
  input: unknown,
  options: {
    toolCallId: string
    conversationKey: string
    turnId: string
    abortSignal: AbortSignal
    messages?: ModelMessage[]
    context?: { conversationKey?: string }
  },
) => Promise<unknown>

type ExecutionBridge = {
  onToolExecution: (callback: (payload: ChatToolExecution) => void) => () => void
  toolResult: (payload: ChatToolResult) => Promise<unknown>
}

type ConversationRegistry = {
  tools: Map<string, { schema: unknown; description: string; execute?: ToolExecutor }>
  /** Live executions for this conversation, keyed by bridge requestId. */
  controllers: Map<string, AbortController>
  /** The conversation's live UI messages, for tools that read `options.messages`. */
  getMessages?: () => AipgUiMessage[] | undefined
}

const registries = new Map<string, ConversationRegistry>()
let bridge: ExecutionBridge | null = null
let wired = false
let unsubscribe: (() => void) | null = null

export function setChatToolExecutionBridgeForTest(fake: ExecutionBridge | null): void {
  if (unsubscribe) {
    unsubscribe()
    unsubscribe = null
  }
  wired = false
  bridge = fake
  registries.clear()
}

function defaultBridge(): ExecutionBridge {
  return {
    onToolExecution: (callback) => window.electronAPI.chat.onToolExecution(callback),
    toolResult: (payload) => window.electronAPI.chat.toolResult(payload),
  }
}

function ensureWired(): void {
  if (wired) return
  wired = true
  const active = bridge ?? defaultBridge()
  bridge = active
  unsubscribe = active.onToolExecution((payload) => void handleExecution(payload))
}

/** Best-effort zod → JSON Schema; permissive fallback keeps a turn alive. */
function serializeInputSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object') {
    const asRecord = schema as Record<string, unknown>
    // provider-utils jsonSchema() wrapper (MCP tools): raw schema rides inside.
    if (asRecord.jsonSchema && typeof asRecord.jsonSchema === 'object') {
      return asRecord.jsonSchema as Record<string, unknown>
    }
    if (typeof (asRecord as { safeParse?: unknown }).safeParse === 'function') {
      try {
        return z.toJSONSchema(schema as ZodType) as Record<string, unknown>
      } catch (error) {
        console.error('Failed to serialize tool input schema:', error)
        return { type: 'object' }
      }
    }
    return asRecord
  }
  return { type: 'object' }
}

/**
 * A ToolSet entry as the turn request ships it: pure data, with the execute
 * closure kept aside for the registry.
 */
export function serializeToolSet(toolSet: ToolSet): ChatToolSpec[] {
  const specs: ChatToolSpec[] = []
  for (const [name, tool] of Object.entries(toolSet)) {
    const record = tool as unknown as {
      description?: string
      inputSchema?: unknown
      execute?: unknown
    }
    specs.push({
      name,
      description: record.description ?? '',
      inputSchema: serializeInputSchema(record.inputSchema),
    })
  }
  return specs
}

/**
 * Registers a conversation's live tool set. One turn runs per conversation at
 * a time, so the latest activation for a conversationKey serves the
 * `chat:executeTool` callbacks; a previous registry (finished turn) is
 * replaced, and its controllers were already settled.
 */
export function activateChatToolSet(
  conversationKey: string,
  toolSet: ToolSet,
  getMessages?: () => AipgUiMessage[] | undefined,
): ChatToolSpec[] {
  ensureWired()
  const registry: ConversationRegistry = { tools: new Map(), controllers: new Map(), getMessages }
  for (const [name, tool] of Object.entries(toolSet)) {
    const record = tool as unknown as {
      description?: string
      inputSchema?: unknown
      execute?: unknown
    }
    registry.tools.set(name, {
      schema: record.inputSchema,
      description: record.description ?? '',
      execute: record.execute as ToolExecutor | undefined,
    })
  }
  registries.set(conversationKey, registry)
  return serializeToolSet(toolSet)
}

/** Drops a conversation's registry once its turn settled (or before a switch). */
export function deactivateChatToolSet(conversationKey: string): void {
  registries.delete(conversationKey)
}

/**
 * Aborts live renderer-side tool executions — the renderer twin of the
 * engine's `abortTurnToolRequests` — so a stopped turn also cancels the work
 * in progress here (a ComfyUI run, a long MCP call) instead of merely
 * discarding its result when it eventually returns.
 */
export function abortChatToolExecutions(conversationKey?: string): void {
  for (const [key, registry] of registries) {
    if (conversationKey && key !== conversationKey) continue
    for (const controller of registry.controllers.values()) controller.abort()
  }
}

async function handleExecution(payload: ChatToolExecution): Promise<void> {
  const active = bridge
  if (!active) return
  const registry = registries.get(payload.conversationKey)
  const settle = (result: ChatToolResult) => active.toolResult(result)
  const entry = registry?.tools.get(payload.toolName)
  if (!registry || !entry) {
    await settle({
      requestId: payload.requestId,
      error: `Tool ${payload.toolName} is not available for this conversation`,
    })
    return
  }
  if (typeof entry.execute !== 'function') {
    await settle({ requestId: payload.requestId, error: `Tool ${payload.toolName} cannot execute` })
    return
  }
  // The original zod schema validates what main's JSON-Schema tools cannot.
  if (entry.schema && typeof (entry.schema as { safeParse?: unknown }).safeParse === 'function') {
    const parsed = (entry.schema as ZodType).safeParse(payload.input)
    if (!parsed.success) {
      await settle({
        requestId: payload.requestId,
        error: `Invalid tool input: ${parsed.error.message}`,
      })
      return
    }
  }
  const controller = new AbortController()
  registry.controllers.set(payload.requestId, controller)
  // Tools that read `options.messages` need the ModelMessage history their
  // original streamText would have passed. For a parent-turn tool that is the
  // conversation itself — rebuilt from the UI messages the turn request
  // shipped, through the same pipeline the old in-renderer prompt used (a
  // stored thread's orphaned/bulky parts behave identically). A nested-run
  // tool (media specialist inner tools, registered under the run key) instead
  // receives the nested history main shipped with the request — the renderer
  // cannot reconstruct it. Conversion can throw on a malformed stored thread;
  // a tool that never reads messages must not fail for that.
  let messages: ModelMessage[] | undefined
  if (Array.isArray(payload.messages)) {
    messages = payload.messages as ModelMessage[]
  } else {
    try {
      // Same pipeline the old in-renderer streamText prompt used, so a stored
      // thread's orphaned/bulky parts behave identically here.
      messages = await convertToModelMessages(
        sanitizeBulkyToolOutputs(completeOrphanedToolParts(registry.getMessages?.() ?? [])),
      )
    } catch {
      messages = undefined
    }
  }
  try {
    const output = await entry.execute(payload.input, {
      toolCallId: payload.toolCallId,
      conversationKey: payload.conversationKey,
      turnId: payload.turnId,
      abortSignal: controller.signal,
      messages,
      context: { conversationKey: payload.conversationKey },
    })
    await settle({ requestId: payload.requestId, output })
  } catch (error) {
    await settle({
      requestId: payload.requestId,
      error: error instanceof Error ? error.message : String(error),
      aborted: controller.signal.aborted,
    })
  } finally {
    registry.controllers.delete(payload.requestId)
  }
}
