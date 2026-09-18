import { NoSuchToolError, type ModelMessage } from 'ai'
import { appLoggerInstance } from '../observability/logger'
import { createToolAgent, type ToolAgentEvent, type ToolAgentRunOptions } from '@/lib/toolAgent'
import { repairWorkflowToolInput } from '@/lib/comfyToolRepair'
import type { MediaAgentRunRequest, MediaAgentRunResult, WorkflowRepairData } from '@/types/chatIpc'
import { emitMediaAgentEvent, endMediaAgentRun } from '../kernel/kernelBus'
import { runMediaRequest } from '../kernel/orchestrator'
import { markDelegatedMediaRun, noteMainChatTurnContext } from '../observability/laminar'
import { createMainChatModel } from './chatModelMain'
import { buildToolSet } from './turnEngine'
import { executeChatComfyTool } from './chatComfyTool'

// ── Nested media specialist, run in main (docs/architecture-target.md §8) ───
//
// The nested LLM loop runs here. Its catalog is Comfy only (comfyUI /
// comfyUiImageEdit), executed in-process against the Artifact runner — the same
// `executeChatComfyTool` Chat parent turns use when delegation is off. Live
// progress is `media-agent-event` kernel events.

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
  return await executeChatComfyTool({
    toolName,
    input,
    messages: execOptions.messages,
    abortSignal: execOptions.abortSignal ?? controller.signal,
    conversationKey: request.conversationKey,
    keepModelsLoaded: request.keepModelsLoaded ?? false,
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
 * Runs one delegated media request. Its tools execute in-process; edit
 * source-image discovery reads the nested ModelMessage history in main.
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
  const tools = buildToolSet(request.toolSpecs, request.runKey, request.repairData, {
    execute: async (spec, input, execOptions) => {
      if (INNER_COMFY_TOOLS.has(spec.name)) {
        return await executeInnerComfy(request, spec.name, input, execOptions, controller)
      }
      throw new Error(`${spec.name} is not a media specialist tool`)
    },
  })
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
 * nested run: aborting the stream also aborts the inner Comfy calls, which run
 * here and take the same signal, so a stopped run stops its ComfyUI work.
 */
export function cancelMediaAgentRun(runKey: string): void {
  const controller = activeRuns.get(runKey)
  if (!controller) {
    appLogger.warn(`media agent cancel for unknown run ${runKey}`, 'chat')
    return
  }
  controller.abort()
}

/** Main calls this when the kernel window changes. */
export function activeMediaAgentRunKeys(): string[] {
  return [...activeRuns.keys()]
}
