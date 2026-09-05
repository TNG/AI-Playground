import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  APICallError,
  convertToModelMessages,
  isStepCount,
  NoSuchToolError,
  streamText,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import { dynamicTool, jsonSchema, type ToolResultOutput } from '@ai-sdk/provider-utils'
import type { JSONSchema7 } from '@ai-sdk/provider'
import { appLoggerInstance } from '../logging/logger'
import { completeOrphanedToolParts, sanitizeBulkyToolOutputs } from '@/lib/toolMessageSanitize'
import { slimMediaModelOutput } from '@/lib/mediaModelOutput'
import { repairWorkflowToolInput } from '@/lib/comfyToolRepair'
import { extractMessage } from '@/assets/js/errors/appError'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import {
  ChatTurnRequestSchema,
  type ChatToolExecution,
  type ChatToolSpec,
  type ChatTurnRequest,
  type ChatTurnSubmitResult,
  type WorkflowRepairData,
} from '@/types/chatIpc'
import {
  beginChatTurnSnapshot,
  emitChatChunk,
  endChatTurn,
  getChatTurnChunks,
} from '../kernel/kernelBus'
import { listMcpServers, getMcpServerStatus } from '../subprocesses/mcpManager'
import { createMainChatModel } from './chatModelMain'
import { abortTurnToolRequests, executeToolInRenderer } from './toolBridge'

// ── Main-side chat turn engine (docs/architecture-target.md §7, step 6) ──────
//
// Port of the renderer's `customFetch` (store/openAiCompatibleChat.ts): main
// owns the AI SDK call. The turn arrives as resolved data (messages, model
// config, serialized tool specs); what streamed through
// `toUIMessageStreamResponse` now crosses the kernel bus as `chat-chunk`
// events, coalesced at the bus. Tool execution round-trips to the renderer,
// which owns the tool closures and their Pinia reads.
//
// What deliberately stayed renderer-side: turn preparation (backend readiness,
// RAG context, system prompt resolution), the activities sink (the transport
// observes chunk types to drive "Processing prompt…" state), message state and
// persistence (the Chat instance keeps them), and the reasoning-in-progress
// flag (derived from the same chunk types).

const appLogger = appLoggerInstance

export type ChatEngineDeps = {
  /** Reads an `aipg-media://` URL into a base64 data URI; throws on failure. */
  readMediaAsDataUri: (url: string) => Promise<string>
  /** Tracing hooks (no-op unless the developer opted into Laminar). */
  noteTimings?: (timings: LlamaCppTimings) => void
  /** The turn's trace context (backend, device, thinking, sampling) to stamp spans with. */
  noteTraceContext?: (context: Record<string, unknown> | null) => void
}

let engineDeps: ChatEngineDeps | null = null

export function setChatEngineDeps(deps: ChatEngineDeps): void {
  engineDeps = deps
}

export function resetChatEngineDepsForTest(): void {
  engineDeps = null
  activeTurns.clear()
}

// ── Inference error surfacing (ported from the chat store) ────────────────────

function describeInferenceError(error: unknown): string {
  if (APICallError.isInstance(error)) {
    const body = typeof error.responseBody === 'string' ? error.responseBody.trim() : ''
    const detail = body || error.message
    const status = error.statusCode ? `HTTP ${error.statusCode}` : ''
    const capped = detail.length > 500 ? `${detail.slice(0, 500)}…` : detail
    return [status, capped].filter(Boolean).join(': ') || 'Inference request failed'
  }
  return extractMessage(error)
}

// ── Raw llama.cpp timings (ported schemas) ─────────────────────────────────────

const LlamaCppRawValueTimingsSchema = z.object({
  cache_n: z.number(),
  prompt_n: z.number(),
  prompt_ms: z.number(),
  prompt_per_token_ms: z.number(),
  prompt_per_second: z.number(),
  predicted_n: z.number(),
  predicted_ms: z.number(),
  predicted_per_token_ms: z.number(),
  predicted_per_second: z.number(),
})

export type LlamaCppTimings = z.infer<typeof LlamaCppRawValueTimingsSchema>

const LlamaCppRawValueSchema = z.object({
  usage: z
    .object({
      completion_tokens: z.number(),
      prompt_tokens: z.number(),
      total_tokens: z.number(),
    })
    .optional(),
  timings: LlamaCppRawValueTimingsSchema.optional(),
})

// ── MCP instructions (ported from resolveMcpInstructions) ──────────────────────

function buildMcpInstructions(include: boolean): string {
  if (!include) return ''
  try {
    const blocks: string[] = []
    for (const server of listMcpServers()) {
      const trimmed = server.instructions?.trim()
      if (!trimmed) continue
      if (getMcpServerStatus(server.id).state !== 'running') continue
      blocks.push(`## MCP server: ${server.name}\n${trimmed}`)
    }
    if (blocks.length === 0) return ''
    return `\n\n# MCP server instructions\n\n${blocks.join('\n\n')}`
  } catch (error) {
    appLogger.warn(
      `Failed to list MCP servers for instructions: ${extractMessage(error)}`,
      'electron-backend',
    )
    return ''
  }
}

// ── Message preparation (ported from customFetch) ─────────────────────────────

async function convertMediaReferences(messages: ModelMessage[]): Promise<ModelMessage[]> {
  const deps = engineDeps
  return await Promise.all(
    messages.map(async (msg) => {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg
      const content = await Promise.all(
        msg.content.map(async (part) => {
          const ref = part.type === 'file' ? (part.data as { type?: string; url?: URL }) : undefined
          if (
            part.type === 'file' &&
            part.mediaType?.startsWith('image/') &&
            ref?.type === 'url' &&
            ref.url?.protocol === 'aipg-media:'
          ) {
            if (!deps) throw new Error('Chat engine deps not wired')
            const dataUri = await deps.readMediaAsDataUri(ref.url.toString())
            return { ...part, data: { type: 'url' as const, url: new URL(dataUri) } }
          }
          return part
        }),
      )
      return { ...msg, content }
    }),
  )
}

function slimToolResults(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== 'tool') return m
    return {
      ...m,
      content: m.content.map((part) => {
        // Replayed `media` results carry the rich UI output (incl. bulky
        // per-item settings); condense to the same slim shape toModelOutput
        // sends live, so delegation stays thin across turns.
        if (
          part.type === 'tool-result' &&
          part.toolName === 'media' &&
          part.output.type === 'json'
        ) {
          const value = part.output.value as { images?: unknown } | null
          if (value && Array.isArray(value.images)) {
            return {
              ...part,
              output: slimMediaModelOutput(value as never) as ToolResultOutput,
            }
          }
          return part
        }
        if (
          part.type === 'tool-result' &&
          part.toolName === 'visualizeObjectDetections' &&
          part.output.type === 'json'
        ) {
          return {
            ...part,
            output: {
              type: 'text',
              value: 'Object detections visualized on image successfully',
            } as ToolResultOutput,
          }
        }
        if (
          part.type === 'tool-result' &&
          part.toolName === 'synthesizeTextToSpeech' &&
          part.output.type === 'json'
        ) {
          const value = part.output.value as {
            ok?: boolean
            message?: string
            savedFilePath?: string
          } | null
          const text =
            value?.ok === false
              ? (value.message ?? 'Speech synthesis failed.')
              : `${value?.message ?? 'Speech synthesized successfully.'}${
                  value?.savedFilePath ? ` File: ${value.savedFilePath}` : ''
                }`
          return {
            ...part,
            output: { type: 'text', value: text } as ToolResultOutput,
          }
        }
        return part
      }),
    }
  })
}

// Screenshot tool results carry the capture as a data URI. The
// OpenAI-compatible provider JSON.stringifies a tool result's value into the
// tool message text, so the raw base64 would be sent as text. Instead,
// replace the tool result with a short text and inject the capture as a real
// vision image in a following user message — the path the backend supports.
function injectScreenshotImages(messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((m): ModelMessage[] => {
    if (m.role !== 'tool') return [m]
    const injectedImages: Array<{ mediaType: string; data: string; windowName: string }> = []
    const content = m.content.map((part) => {
      if (
        part.type === 'tool-result' &&
        (part.toolName === 'captureScreenshot' || part.toolName === 'screenshotWebPage') &&
        part.output.type === 'json'
      ) {
        const value = part.output.value as {
          ok?: boolean
          windowName?: string
          dataUri?: string
        } | null
        if (value?.ok && typeof value.dataUri === 'string') {
          const mediaType =
            value.dataUri.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,/)?.[1] ?? 'image/png'
          const windowName =
            value.windowName ?? (part.toolName === 'screenshotWebPage' ? 'web page' : 'window')
          injectedImages.push({ mediaType, data: value.dataUri, windowName })
          return {
            ...part,
            output: {
              type: 'text',
              value: `Screenshot of "${windowName}" captured. The image is attached in the following message.`,
            } as ToolResultOutput,
          }
        }
      }
      return part
    })
    const rewritten = { ...m, content } as ModelMessage
    if (injectedImages.length === 0) return [rewritten]
    const imageMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'Here is the captured screenshot to inspect:' },
        ...injectedImages.map((img) => ({
          type: 'file' as const,
          mediaType: img.mediaType,
          data: { type: 'url' as const, url: new URL(img.data) },
        })),
      ],
    } as ModelMessage
    return [rewritten, imageMessage]
  })
}

function filterNonVisionContent(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const filteredContent = msg.content.filter((part) => part.type === 'text')
      if (filteredContent.length === 0) {
        return {
          ...msg,
          content: [
            {
              type: 'text' as const,
              text: 'This message contained an image, but the model does not support vision.',
            },
          ],
        }
      }
      return { ...msg, content: filteredContent }
    }
    return msg
  })
}

const MAX_HISTORY_IMAGES = 2

function capHistoryImages(messages: ModelMessage[]): {
  messages: ModelMessage[]
  kept: number
  dropped: number
} {
  let keptImages = 0
  let droppedImages = 0
  const capped = [...messages]
  for (let i = capped.length - 1; i >= 0; i--) {
    const content = capped[i].content
    if (!Array.isArray(content)) continue
    let changed = false
    const newContent = content.map((part) => {
      const p = part as { type: string; mediaType?: string }
      if (p.type !== 'file' || !p.mediaType?.startsWith('image/')) return part
      if (keptImages < MAX_HISTORY_IMAGES) {
        keptImages++
        return part
      }
      changed = true
      droppedImages++
      return { type: 'text', text: '[earlier image omitted]' } as typeof part
    })
    if (changed) capped[i] = { ...capped[i], content: newContent } as ModelMessage
  }
  return { messages: capped, kept: keptImages, dropped: droppedImages }
}

// ── Tool set from serialized specs ────────────────────────────────────────────

/**
 * `jsonSchema()` without a `validate` option accepts anything, so the SDK's
 * tool-input validation — the trigger for the comfy workflow repair — would
 * be gone. The only validation the original zod ToolSet performed that has a
 * behavioral consumer is the comfy tools' `workflow` membership (the repair
 * path exists for exactly that); enforce it here from the shipped repair
 * names. Everything else passes through unvalidated, same as today's model
 * args that zod would have caught surface as errors only via the executor.
 */
export function buildToolSet(
  specs: ChatToolSpec[],
  conversationKey: string,
  turnId: string,
  repairData: ChatTurnRequest['repairData'],
  options?: {
    /**
     * Ship the live ModelMessage history with each bridge request — needed
     * when the tool set belongs to a nested run whose history the renderer
     * cannot reconstruct from a conversation (the media specialist's edit
     * tool discovers its source image in the nested history).
     */
    includeMessages?: boolean
  },
): ToolSet {
  const tools: ToolSet = {}
  for (const spec of specs) {
    const data: WorkflowRepairData | undefined =
      spec.name === 'comfyUiImageEdit'
        ? repairData?.comfyUiImageEdit
        : spec.name === 'comfyUI'
          ? repairData?.comfyUI
          : undefined
    tools[spec.name] = dynamicTool({
      description: spec.description,
      inputSchema: data
        ? jsonSchema(spec.inputSchema as JSONSchema7, {
            validate: async (value: unknown) => {
              const workflow = (value as { workflow?: unknown } | null)?.workflow
              if (typeof workflow === 'string' && data.names.includes(workflow)) {
                return { success: true as const, value }
              }
              return {
                success: false as const,
                error: new Error(
                  `Invalid workflow ${typeof workflow === 'string' ? `"${workflow}"` : '(missing)'} for ${spec.name}`,
                ),
              }
            },
          })
        : jsonSchema(spec.inputSchema as JSONSchema7),
      execute: async (input, execOptions) =>
        await executeToolInRenderer({
          conversationKey,
          turnId,
          toolCallId: execOptions.toolCallId,
          toolName: spec.name,
          input,
          ...(options?.includeMessages ? { messages: execOptions.messages } : {}),
        }),
    }) as ToolSet[string]
  }
  return tools
}

// ── Turn lifecycle ────────────────────────────────────────────────────────────

type ActiveChatTurn = {
  turnId: string
  conversationKey: string
  controller: AbortController
}

const activeTurns = new Map<string, ActiveChatTurn>()

export function chatTurnActive(conversationKey: string): boolean {
  return activeTurns.has(conversationKey)
}

/** Any conversation streaming: the GPU-handoff guard image tools wait on. */
export function anyChatTurnActive(): boolean {
  return activeTurns.size > 0
}

export function submitChatTurn(request: unknown): ChatTurnSubmitResult {
  const req = ChatTurnRequestSchema.parse(request) as ChatTurnRequest
  if (activeTurns.has(req.conversationKey)) {
    throw new Error('A chat turn is already running for this conversation')
  }
  const turnId = randomUUID()
  const turn: ActiveChatTurn = {
    turnId,
    conversationKey: req.conversationKey,
    controller: new AbortController(),
  }
  activeTurns.set(req.conversationKey, turn)
  beginChatTurnSnapshot(req.conversationKey, turnId)
  void runChatTurn(req, turn)
  return { turnId }
}

export function cancelChatTurn(conversationKey: string, turnId: string): void {
  const turn = activeTurns.get(conversationKey)
  if (!turn || turn.turnId !== turnId) return
  turn.controller.abort()
  abortTurnToolRequests(turnId)
}

export function resumeChatTurn(conversationKey: string) {
  const turn = activeTurns.get(conversationKey)
  if (!turn) return null
  const captured = getChatTurnChunks(conversationKey, turn.turnId)
  if (!captured) return null
  return { turnId: turn.turnId, ...captured }
}

async function runChatTurn(request: ChatTurnRequest, turn: ActiveChatTurn): Promise<void> {
  const { conversationKey, turnId } = turn
  const haDiag = request.homeAgentDiagnostics === true
  try {
    const config = request.model

    // Self-heal orphaned tool calls (interrupted/stopped turns, HMR) before
    // converting: an assistant tool-call with no matching result would make
    // convertToModelMessages/streamText throw "Tool result is missing …".
    let messages = await convertToModelMessages(
      sanitizeBulkyToolOutputs(
        completeOrphanedToolParts(request.messages as unknown as AipgUiMessage[]),
      ),
    )

    messages = await convertMediaReferences(messages)
    messages = slimToolResults(messages)
    messages = injectScreenshotImages(messages)
    if (config.supportsVision) {
      const capped = capHistoryImages(messages)
      messages = capped.messages
      if (haDiag && (capped.kept || capped.dropped)) {
        appLogger.info(
          `[HA-DIAG] images kept=${capped.kept} droppedFromHistory=${capped.dropped}`,
          'home-agent-diag',
        )
      }
    } else {
      messages = filterNonVisionContent(messages)
    }

    const systemPromptToUse = `${request.systemPrompt ?? ''}${buildMcpInstructions(
      request.includeMcpInstructions === true,
    )}`
    const tools = buildToolSet(request.tools, conversationKey, turnId, request.repairData)
    const hasTools = Object.keys(tools).length > 0

    if (haDiag) {
      const toolNames = Object.keys(tools)
      appLogger.info(
        `[HA-DIAG] turn start model=${config.modelId} backend=${config.backend} ` +
          `tools=${toolNames.length} [${toolNames.join(',')}] ` +
          `systemPromptChars=${systemPromptToUse.length} inputMsgs=${messages.length} stepCap=20`,
        'home-agent-diag',
      )
    }

    const repairData = request.repairData

    // The context the request shipped (backend, device, thinking, sampling) is
    // what Laminar stamps this turn's spans with; tracing stays off unless the
    // deps seam was wired.
    engineDeps?.noteTraceContext?.((config.trace as Record<string, unknown> | undefined) ?? null)

    const diagTurnStart = Date.now()
    let diagStepIdx = 0
    const startOfRequestTime = Date.now()
    let firstTokenTime = 0
    let finishTime = 0
    let timings: LlamaCppTimings | undefined = undefined
    let usage: LanguageModelUsage | undefined = undefined
    let usageFromRawChunk: LanguageModelUsage | undefined = undefined
    let lastStepUsage: LanguageModelUsage | undefined = undefined
    const reasoningTimings = new Map<string, { started: number; finished: number }>()
    // A reasoning block is a contiguous run of reasoning deltas; any
    // non-reasoning content ends it and the next delta opens a fresh block.
    // An "interrupted?" check (not a time gap) keeps slow models from
    // resetting the block on every token.
    let reasoningInterrupted = true

    const result = await streamText({
      model: createMainChatModel(config),
      messages,
      abortSignal: turn.controller.signal,
      instructions: systemPromptToUse,
      maxOutputTokens: config.maxOutputTokens,
      temperature: config.temperature,
      ...(hasTools
        ? {
            tools,
            stopWhen: isStepCount(20),
            ...(repairData
              ? {
                  // Repair a comfy image tool call whose `workflow` the model
                  // omitted or set to an unknown value: coerce it to that
                  // tool's default workflow. Without this the SDK drops the
                  // bad call and the chat renders an "unknown preset" card /
                  // failed generation.
                  experimental_repairToolCall: async ({ toolCall, error }) => {
                    if (NoSuchToolError.isInstance(error)) return null
                    const data: WorkflowRepairData | undefined =
                      toolCall.toolName === 'comfyUiImageEdit'
                        ? repairData.comfyUiImageEdit
                        : toolCall.toolName === 'comfyUI'
                          ? repairData.comfyUI
                          : undefined
                    if (!data) return null
                    const repaired = repairWorkflowToolInput(toolCall.input, data)
                    if (repaired === null) return null
                    return { ...toolCall, input: repaired }
                  },
                }
              : {}),
          }
        : {}),

      onChunk: (chunk) => {
        const chunkType = chunk.chunk.type
        if (haDiag && (chunkType === 'tool-call' || chunkType === 'tool-result')) {
          const c = chunk.chunk as { toolName?: string; toolCallId?: string }
          const t = timings
          appLogger.info(
            `[HA-DIAG] ${chunkType} tool=${c.toolName ?? '?'} id=${c.toolCallId ?? '?'} ` +
              `promptN=${t?.prompt_n ?? '?'} cacheN=${t?.cache_n ?? '?'} promptMs=${
                t?.prompt_ms == null ? '?' : Math.round(t.prompt_ms)
              }`,
            'home-agent-diag',
          )
        }
        if (chunk.chunk.type === 'raw') {
          const rawValue = LlamaCppRawValueSchema.safeParse(chunk.chunk.rawValue)
          if (rawValue.success) {
            if (rawValue.data.timings) {
              timings = rawValue.data.timings
            }
            if (rawValue.data.usage) {
              // Usage rides the step's final chunk — the last look at its
              // timings before the AI SDK closes the call.
              if (timings) engineDeps?.noteTimings?.(timings)
              const u = rawValue.data.usage
              usageFromRawChunk = {
                inputTokens: u.prompt_tokens,
                outputTokens: u.completion_tokens,
                totalTokens: u.total_tokens,
                inputTokenDetails: {
                  noCacheTokens: undefined,
                  cacheReadTokens: undefined,
                  cacheWriteTokens: undefined,
                },
                outputTokenDetails: {},
              } as LanguageModelUsage
              if (!timings) {
                const now = Date.now()
                const promptMs = Math.max(
                  0,
                  firstTokenTime ? firstTokenTime - startOfRequestTime : 0,
                )
                const predictedMs = Math.max(
                  0,
                  firstTokenTime ? now - firstTokenTime : now - startOfRequestTime,
                )
                timings = {
                  cache_n: 0,
                  prompt_n: u.prompt_tokens,
                  prompt_ms: promptMs,
                  prompt_per_token_ms: u.prompt_tokens > 0 ? promptMs / u.prompt_tokens : 0,
                  prompt_per_second: promptMs > 0 ? (u.prompt_tokens / promptMs) * 1000 : 0,
                  predicted_n: u.completion_tokens,
                  predicted_ms: predictedMs,
                  predicted_per_token_ms:
                    u.completion_tokens > 0 ? predictedMs / u.completion_tokens : 0,
                  predicted_per_second:
                    predictedMs > 0 ? (u.completion_tokens / predictedMs) * 1000 : 0,
                }
              }
            }
          }
        }
        // Track per-block reasoning timing: the SDK reuses one reasoning ID
        // across tool-call cycles but never emits start/end, so a new block
        // is "reasoning resumed after other content".
        if (chunk.chunk.type === 'reasoning-delta') {
          if (!firstTokenTime) {
            firstTokenTime = Date.now()
          }
          const reasoningId = chunk.chunk.id
          const now = Date.now()
          let timing = reasoningTimings.get(reasoningId)
          if (!timing || reasoningInterrupted) {
            timing = { started: now, finished: now }
            reasoningTimings.set(reasoningId, timing)
          } else {
            timing.finished = now
          }
          reasoningInterrupted = false
          chunk.chunk.providerMetadata = {
            aipg: {
              reasoningStarted: timing.started,
              reasoningFinished: timing.finished,
            },
          }
        }
        if (chunk.chunk.type === 'text-delta') {
          if (!firstTokenTime) {
            firstTokenTime = Date.now()
          }
        }
      },

      onStepEnd: (step) => {
        if (haDiag) {
          diagStepIdx++
          const calls = step.toolCalls.map((c) => c.toolName).join(',') || 'none'
          const t = timings
          const ms = (v?: number) => (v == null ? '?' : Math.round(v))
          appLogger.info(
            `[HA-DIAG] step ${diagStepIdx} finishReason=${step.finishReason} ` +
              `inTok=${step.usage?.inputTokens ?? '?'} outTok=${step.usage?.outputTokens ?? '?'} ` +
              `promptN=${t?.prompt_n ?? '?'} cacheN=${t?.cache_n ?? '?'} promptMs=${ms(t?.prompt_ms)} ` +
              `predN=${t?.predicted_n ?? '?'} predMs=${ms(t?.predicted_ms)} ` +
              `toolCalls=${step.toolCalls.length} [${calls}] textLen=${step.text?.length ?? 0}`,
            'home-agent-diag',
          )
        }
      },

      onEnd: (result) => {
        finishTime = Date.now()
        if (haDiag) {
          appLogger.info(
            `[HA-DIAG] turn done steps=${diagStepIdx} wallMs=${finishTime - diagTurnStart} ` +
              `finalInTok=${result.usage?.inputTokens ?? '?'} finalOutTok=${
                result.usage?.outputTokens ?? '?'
              }`,
            'home-agent-diag',
          )
        }
        if (result.usage) {
          usage = result.usage
        } else if (usageFromRawChunk) {
          usage = usageFromRawChunk
        }
        if (!timings) {
          const effectiveUsage = result.usage ?? usageFromRawChunk
          const promptMs = Math.max(0, firstTokenTime ? firstTokenTime - startOfRequestTime : 0)
          const predictedMs = Math.max(
            0,
            firstTokenTime ? finishTime - firstTokenTime : finishTime - startOfRequestTime,
          )
          const inputTokens = effectiveUsage?.inputTokens ?? 0
          const outputTokens = effectiveUsage?.outputTokens ?? 0
          timings = {
            cache_n: effectiveUsage?.inputTokenDetails?.cacheReadTokens ?? 0,
            prompt_n: inputTokens,
            prompt_ms: promptMs,
            prompt_per_token_ms: inputTokens > 0 ? promptMs / inputTokens : 0,
            prompt_per_second: promptMs > 0 ? (inputTokens / promptMs) * 1000 : 0,
            predicted_n: outputTokens,
            predicted_ms: predictedMs,
            predicted_per_token_ms: outputTokens > 0 ? predictedMs / outputTokens : 0,
            predicted_per_second: predictedMs > 0 ? (outputTokens / predictedMs) * 1000 : 0,
          }
        }
      },

      onError: (error) => {
        appLogger.warn(`Chat turn failed: ${describeInferenceError(error)}`, 'electron-backend')
      },

      include: {
        rawChunks: true,
      },
    })

    const stream = result.toUIMessageStream({
      onError: describeInferenceError,
      sendReasoning: true,
      messageMetadata: (options) => {
        // Returning undefined suppresses the SDK's per-part `message-metadata`
        // chunk: without this it enqueues one after every delta and raw part,
        // so no two deltas are ever adjacent and the bus coalescing could
        // never merge anything.
        if (
          options.part.type === 'text-delta' ||
          options.part.type === 'reasoning-delta' ||
          options.part.type === 'raw'
        ) {
          return undefined
        }
        if (options.part.type === 'finish-step') {
          lastStepUsage = options.part.usage
        }
        let effectiveUsage: LanguageModelUsage | undefined = undefined
        if (options.part.type === 'finish') {
          effectiveUsage = lastStepUsage ?? options.part.totalUsage
        }
        return {
          model: config.modelId,
          timestamp: Date.now(),
          timings,
          usage: effectiveUsage ?? usage,
        }
      },
    })

    for await (const chunk of stream) {
      emitChatChunk(conversationKey, turnId, chunk)
    }
  } catch (error) {
    // A user stop must not surface as an error chunk — the renderer's manual-
    // stop guard expects a clean stream end, same as the aborted fetch before
    // the move.
    if (!turn.controller.signal.aborted) {
      appLogger.error(`Chat turn crashed: ${describeInferenceError(error)}`, 'electron-backend')
      emitChatChunk(conversationKey, turnId, {
        type: 'error',
        errorText: describeInferenceError(error),
      })
    }
  } finally {
    activeTurns.delete(conversationKey)
    endChatTurn(conversationKey, turnId)
  }
}

export type { ChatToolExecution }
