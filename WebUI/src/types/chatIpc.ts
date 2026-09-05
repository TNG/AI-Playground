import { z } from 'zod'
import type { UIMessageChunk } from 'ai'

// The chat-turn IPC contract (docs/architecture-target.md §7, step 6): the
// renderer's Chat keeps message state and tool cards, but the AI SDK call
// (`streamText`) lives in main. A turn is submitted as resolved data — model
// config, system prompt, serialized tool specs — and streams back as kernel
// `chat-chunk` events (coalesced at the bus). Tool execution round-trips to
// the renderer, which owns the tool closures and their Pinia reads.

/** `textInference.backend` — which inference surface the turn runs on. */
export const ChatBackendSchema = z.enum(['llamaCPP', 'openVINO', 'cloud'])
export type ChatBackend = z.infer<typeof ChatBackendSchema>

/**
 * Everything the main-side model factory needs, resolved by the renderer at
 * submit time. Backend selection, sampling and thinking kwargs are renderer
 * state; main re-roots the endpoint per request (the llama-server port moves
 * across mid-turn relaunches) and attaches proxy headers itself.
 */
export const ChatModelConfigSchema = z.object({
  backend: ChatBackendSchema,
  /** Model id as the backend expects it on the wire. */
  modelId: z.string(),
  /** The renderer's live backend base URL (main re-resolves per request). */
  baseUrl: z.string().optional(),
  /** Cloud "default" placeholder: omit `model` from the request body. */
  omitModelInBody: z.boolean().optional(),
  /** Cloud provider routing, consumed by the main-process loopback proxy. */
  cloud: z
    .object({
      providerId: z.string(),
      upstreamBaseUrl: z.string().optional(),
      authStyle: z.string(),
    })
    .optional(),
  /** Home Agent active: route through its Flask proxy with upstream + auth headers. */
  homeAgentUpstreamUrl: z.string().optional(),
  /**
   * Local backend restart facts for the relaunch-and-retry path (the renderer's
   * `ensureBackendReadiness` arguments). Absent for cloud / Home Agent relays,
   * which are never restarted mid-turn.
   */
  readiness: z
    .object({
      serviceName: z.string(),
      llmModelName: z.string(),
      embeddingModelName: z.string().optional(),
      contextSize: z.number().optional(),
      modelArgs: z.string().optional(),
    })
    .optional(),
  /** Sampling the publisher recommends + user settings (`textInference.samplingRequestBody`). */
  samplingRequestBody: z.record(z.string(), z.unknown()).optional(),
  /** Thinking toggles / reasoning effort, merged into `chat_template_kwargs`. */
  chatTemplateKwargs: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Vision-capable model: keep image parts (and cap replayed history images). */
  supportsVision: z.boolean().optional(),
  /** Cloud providers inline reasoning; extract it into reasoning parts. */
  extractReasoning: z.boolean().optional(),
  /** Trace context for the turn (no-op unless the developer opted into tracing). */
  trace: z.record(z.string(), z.unknown()).optional(),
  /** Ask llama.cpp for per-token timings in raw chunks (`timings_per_token`). */
  timingsPerToken: z.boolean().optional(),
})
export type ChatModelConfig = z.infer<typeof ChatModelConfigSchema>

/**
 * A chat tool as it crosses to main: name, description and JSON Schema only.
 * Execution stays renderer-side — the closures read Pinia (workflows, speech
 * engines, MCP state) — and main calls them back over `chat:executeTool`.
 */
export const ChatToolSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
})
export type ChatToolSpec = z.infer<typeof ChatToolSpecSchema>

/** Repair data for a comfy tool's malformed workflow field (src/lib/comfyToolRepair). */
export const WorkflowRepairDataSchema = z.object({
  names: z.array(z.string()),
  defaultWorkflow: z.string(),
})
export type WorkflowRepairData = z.infer<typeof WorkflowRepairDataSchema>

/** UI messages cross as-is; the engine trusts the app's own Chat shapes. */
export const ChatMessageSchema = z.object({ id: z.string(), role: z.string() }).passthrough()

export const ChatTurnRequestSchema = z.object({
  conversationKey: z.string().min(1),
  trigger: z.enum(['submit-message', 'regenerate-message']),
  /** Regenerate: the message id to redo; submit: absent. */
  messageId: z.string().optional(),
  messages: z.array(ChatMessageSchema),
  /** Base system prompt (RAG-augmented prompt included when the turn prepared one). */
  systemPrompt: z.string().nullable(),
  model: ChatModelConfigSchema,
  tools: z.array(ChatToolSpecSchema),
  repairData: z
    .object({
      comfyUI: WorkflowRepairDataSchema.optional(),
      comfyUiImageEdit: WorkflowRepairDataSchema.optional(),
    })
    .optional(),
  /** Home Agent preset: enable its temporary per-turn diagnostics logging. */
  homeAgentDiagnostics: z.boolean().optional(),
  /** MCP tools are exposed: append running servers' instructions to the prompt. */
  includeMcpInstructions: z.boolean().optional(),
})
export type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>

export const ChatTurnSubmitResultSchema = z.object({
  turnId: z.string(),
})
export type ChatTurnSubmitResult = z.infer<typeof ChatTurnSubmitResultSchema>

/**
 * A running turn's coalesced chunk log at a bus sequence — the resume
 * handshake's replay data. Null when the conversation has no live turn.
 */
export const ChatTurnResumeSchema = z.object({
  turnId: z.string(),
  chunks: z.array(z.record(z.string(), z.unknown())),
  /** Bus sequence the chunks were captured at; apply only events above it. */
  sequence: z.number(),
})
// Chunks cross IPC as records (a full UIMessageChunk zod mirror would dwarf
// the contract); the engine produces them via toUIMessageStream, so the TS
// side states the real element type.
export type ChatTurnResume = Omit<z.infer<typeof ChatTurnResumeSchema>, 'chunks'> & {
  chunks: UIMessageChunk[]
}

/** `chat:resumeTurn` reply: the replay data when a turn is live, else a no-op. */
export const ChatTurnResumeResultSchema = z.object({
  success: z.literal(true),
  active: z.boolean(),
  turnId: z.string().optional(),
  chunks: z.array(z.record(z.string(), z.unknown())).optional(),
  sequence: z.number().optional(),
})
export type ChatTurnResumeResult = Omit<z.infer<typeof ChatTurnResumeResultSchema>, 'chunks'> & {
  chunks?: UIMessageChunk[]
}

export const ChatCancelTurnRequestSchema = z.object({
  conversationKey: z.string().min(1),
  turnId: z.string().min(1),
})
export type ChatCancelTurnRequest = z.infer<typeof ChatCancelTurnRequestSchema>

// ── Tool execution bridge (main → renderer request/response) ─────────────────

export const ChatToolExecutionSchema = z.object({
  requestId: z.string(),
  conversationKey: z.string(),
  turnId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  /**
   * Present only for nested-run tool calls (media specialist): the nested
   * loop's own ModelMessage history, which the inner edit tool searches for
   * its source image. Parent-turn tools get no field here — the registry
   * rebuilds their messages from the conversation.
   */
  messages: z.array(z.unknown()).optional(),
})
export type ChatToolExecution = z.infer<typeof ChatToolExecutionSchema>

export const ChatToolResultSchema = z.object({
  requestId: z.string(),
  /** A JSON-compatible tool output, or the tool's error text. */
  output: z.unknown().optional(),
  error: z.string().optional(),
  /** The turn was aborted while the tool ran; discard the result. */
  aborted: z.boolean().optional(),
})
export type ChatToolResult = z.infer<typeof ChatToolResultSchema>

// ── Nested media specialist run (renderer → main, step 6) ────────────────────

export const MediaAgentRunRequestSchema = z.object({
  /** Registry key the renderer registered the inner tool set under. */
  runKey: z.string().min(1),
  /** Parent conversation key, when the run serves a chat turn. */
  conversationKey: z.string().optional(),
  request: z.string(),
  /** Parent-provided source image, already a data URI. */
  sourceImage: z.string().optional(),
  /** The specialist's system prompt (kept in the renderer: one source of truth). */
  system: z.string(),
  toolSpecs: z.array(ChatToolSpecSchema),
  repairData: z
    .object({
      comfyUI: WorkflowRepairDataSchema.optional(),
      comfyUiImageEdit: WorkflowRepairDataSchema.optional(),
    })
    .optional(),
  model: ChatModelConfigSchema,
})
export type MediaAgentRunRequest = z.infer<typeof MediaAgentRunRequestSchema>

/** The raw tool-agent result; the renderer condenses it into MediaAgentResult. */
export const MediaAgentRunResultSchema = z.object({
  text: z.string(),
  steps: z.array(
    z.object({
      toolName: z.string(),
      input: z.unknown(),
      output: z.unknown(),
    }),
  ),
})
export type MediaAgentRunResult = z.infer<typeof MediaAgentRunResultSchema>

// ── One-shot helpers ──────────────────────────────────────────────────────────

export const ChatSummarizeRequestSchema = z.object({
  messagesText: z.string(),
  model: ChatModelConfigSchema,
})
export type ChatSummarizeRequest = z.infer<typeof ChatSummarizeRequestSchema>
