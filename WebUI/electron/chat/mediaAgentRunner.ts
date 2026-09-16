import { NoSuchToolError, type ModelMessage } from 'ai'
import { appLoggerInstance } from '../observability/logger'
import { createToolAgent, type ToolAgentEvent, type ToolAgentRunOptions } from '@/lib/toolAgent'
import { repairWorkflowToolInput } from '@/lib/comfyToolRepair'
import { findSourceImage } from '@/lib/findSourceImage'
import type { MediaAgentRunRequest, MediaAgentRunResult, WorkflowRepairData } from '@/types/chatIpc'
import { emitMediaAgentEvent, endMediaAgentRun } from '../kernel/kernelBus'
import { runMediaRequest } from '../kernel/orchestrator'
import { markDelegatedMediaRun, noteMainChatTurnContext } from '../observability/laminar'
import { createMainChatModel } from './chatModelMain'
import { buildToolSet } from './turnEngine'
import { abortTurnToolRequests, executeToolInRenderer } from './toolBridge'
import { runInProcessComfyTool, type InProcessComfyArgs } from '../artifact/inProcessComfy'

// ── Nested media specialist, run in main (docs/architecture-target.md §8) ───
//
// The nested LLM loop runs here. Inner Comfy tools (comfyUI / comfyUiImageEdit)
// execute in-process against the Artifact runner (step 12), the way direct
// generateImage / editImage already do. Screenshot and web-browse stay on the
// renderer tool bridge. Live progress is `media-agent-event` kernel events.

const appLogger = appLoggerInstance

const INNER_COMFY_TOOLS = new Set(['comfyUI', 'comfyUiImageEdit'])

const activeRuns = new Map<string, AbortController>()

async function executeInnerComfy(
  request: MediaAgentRunRequest,
  toolName: string,
  input: unknown,
  execOptions: { messages?: ModelMessage[]; abortSignal?: AbortSignal },
  controller: AbortController,
): Promise<Record<string, unknown>> {
  const isEdit = toolName === 'comfyUiImageEdit'
  const source = isEdit ? findSourceImage(execOptions.messages ?? []) : undefined
  if (isEdit && !source) {
    return {
      success: false,
      message: 'No image found in conversation. Please upload an image or generate one first.',
      images: [],
    }
  }
  return await runInProcessComfyTool({
    kind: isEdit ? 'edit' : 'create',
    args: (input ?? {}) as InProcessComfyArgs,
    source: source ?? undefined,
    origin: request.conversationKey ? 'renderer' : 'agent',
    conversationKey: request.conversationKey,
    keepModelsLoaded: request.keepModelsLoaded ?? false,
    signal: execOptions.abortSignal ?? controller.signal,
  })
}

/** Parse a data URI into the file message the nested edit tool discovers. */
function sourceImageMessage(dataUri: string): ModelMessage {
  const mediaType = /^data:(image\/[a-z+.-]+);/i.exec(dataUri)?.[1] ?? 'image/png'
  return {
    role: 'user',
    content: [{ type: 'file', mediaType, data: dataUri }],
  }
}

/**
 * Runs one delegated media request. Inner Comfy tools execute in-process.
 * Other tools (none today) still cross the renderer bridge. Edit source-image
 * discovery reads the nested ModelMessage history in main.
 */
export async function runMediaAgentInMain(
  request: MediaAgentRunRequest,
  abortSignal?: AbortSignal,
): Promise<MediaAgentRunResult> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (abortSignal?.aborted) {
    const error = new Error('Media specialist run aborted.')
    error.name = 'AbortError'
    throw error
  }
  abortSignal?.addEventListener('abort', onAbort, { once: true })
  activeRuns.set(request.runKey, controller)
  try {
    // One media-request bracket at a time, and never while a generation holds
    // the GPU for media: the bracket's own LLM steps need the chat backend
    // (the orchestrator's request lane — the old renderer pipeline's
    // queueMediaRequest, moved to where the specialist runs).
    return await runMediaRequest(() => runMediaAgentBracket(request, controller), {
      runKey: request.runKey,
      conversationKey: request.conversationKey,
      abortSignal: controller.signal,
    })
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
    endMediaAgentRun(request.runKey)
    activeRuns.delete(request.runKey)
  }
}

async function runMediaAgentBracket(
  request: MediaAgentRunRequest,
  controller: AbortController,
): Promise<MediaAgentRunResult> {
  const priorMessages: ModelMessage[] = request.sourceImage
    ? [sourceImageMessage(request.sourceImage)]
    : []
  const tools = buildToolSet(
    request.toolSpecs,
    request.runKey,
    request.runKey,
    request.repairData,
    {
      includeMessages: true,
      execute: async (spec, input, execOptions) => {
        if (INNER_COMFY_TOOLS.has(spec.name)) {
          return await executeInnerComfy(request, spec.name, input, execOptions, controller)
        }
        return await executeToolInRenderer({
          conversationKey: request.runKey,
          turnId: request.runKey,
          toolCallId: execOptions.toolCallId,
          toolName: spec.name,
          input,
          messages: execOptions.messages,
        })
      },
    },
  )
  const agent = createToolAgent({
    name: 'mediaAgent',
    system: () => request.system,
    tools: () => tools,
    maxSteps: 6,
  })
  const onEvent = (event: ToolAgentEvent) => emitMediaAgentEvent(request.runKey, event)
  // Tracing: the run carries the context its request shipped, and its spans
  // belong inside the `media` tool call of the parent turn (no-ops without a
  // Laminar config).
  noteMainChatTurnContext(request.model.trace)
  markDelegatedMediaRun()
  return await agent.run({
    model: createMainChatModel(request.model),
    request: request.request,
    priorMessages,
    abortSignal: controller.signal,
    repairToolCall: request.repairData ? buildRepair(request) : undefined,
    onEvent,
  })
}

function buildRepair(
  request: MediaAgentRunRequest,
): NonNullable<ToolAgentRunOptions['repairToolCall']> {
  return async ({ toolCall, error }) => {
    if (NoSuchToolError.isInstance(error)) return null
    const data: WorkflowRepairData | undefined =
      toolCall.toolName === 'comfyUiImageEdit'
        ? request.repairData?.comfyUiImageEdit
        : toolCall.toolName === 'comfyUI'
          ? request.repairData?.comfyUI
          : undefined
    if (!data) return null
    const repaired = repairWorkflowToolInput(toolCall.input, data)
    if (repaired === null) return null
    return { ...toolCall, input: repaired }
  }
}

/**
 * The renderer aborts its tool call (stopped turn, Pi tool abort) → cancel the
 * nested run: abort the stream and reject inner tool requests still pending,
 * so a stopped run also stops its ComfyUI work.
 */
export function cancelMediaAgentRun(runKey: string): void {
  const controller = activeRuns.get(runKey)
  if (!controller) {
    appLogger.warn(`media agent cancel for unknown run ${runKey}`, 'chat')
    return
  }
  controller.abort()
  abortTurnToolRequests(runKey)
}

/** Main calls this when the kernel window changes: pending inner calls settle via rejectAllChatToolRequests. */
export function activeMediaAgentRunKeys(): string[] {
  return [...activeRuns.keys()]
}
