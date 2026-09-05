import { NoSuchToolError, type ModelMessage } from 'ai'
import { appLoggerInstance } from '../logging/logger'
import { createToolAgent, type ToolAgentEvent, type ToolAgentRunOptions } from '@/lib/toolAgent'
import { repairWorkflowToolInput } from '@/lib/comfyToolRepair'
import type { MediaAgentRunRequest, MediaAgentRunResult, WorkflowRepairData } from '@/types/chatIpc'
import { emitMediaAgentEvent, endMediaAgentRun } from '../kernel/kernelBus'
import { markDelegatedMediaRun, noteMainChatTurnContext } from '../laminar'
import { createMainChatModel } from './chatModelMain'
import { buildToolSet } from './turnEngine'
import { abortTurnToolRequests } from './toolBridge'

// ── Nested media specialist, run in main (docs/architecture-target.md §8) ───
//
// The `media` tool (a renderer-side chat tool, or the Pi agent bridge) used to
// run a nested `streamText` tool loop in the renderer. Step 6 moves every LLM
// call to main, so the loop runs here: the renderer ships the resolved request
// (system prompt, inner tool specs + repair data, model config, source image)
// and keeps only the tool EXECUTIONS — inner comfy tools still drive the
// renderer's artifact pipeline — plus the result condensing. Live progress
// reaches the renderer's timeline as `media-agent-event` kernel events.

const appLogger = appLoggerInstance

const activeRuns = new Map<string, AbortController>()

/** Parse a data URI into the file message the nested edit tool discovers. */
function sourceImageMessage(dataUri: string): ModelMessage {
  const mediaType = /^data:(image\/[a-z+.-]+);/i.exec(dataUri)?.[1] ?? 'image/png'
  return {
    role: 'user',
    content: [{ type: 'file', mediaType, data: dataUri }],
  }
}

/**
 * Runs one delegated media request. The renderer has registered the inner tool
 * executors under `request.runKey` (chatToolRegistry) before submitting; every
 * inner tool call crosses the tool bridge with the nested message history, so
 * the edit tool's source-image discovery sees the run's own chaining.
 */
export async function runMediaAgentInMain(
  request: MediaAgentRunRequest,
): Promise<MediaAgentRunResult> {
  const controller = new AbortController()
  activeRuns.set(request.runKey, controller)
  const priorMessages: ModelMessage[] = request.sourceImage
    ? [sourceImageMessage(request.sourceImage)]
    : []
  const tools = buildToolSet(
    request.toolSpecs,
    request.runKey,
    request.runKey,
    request.repairData,
    { includeMessages: true },
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
  try {
    return await agent.run({
      model: createMainChatModel(request.model),
      request: request.request,
      priorMessages,
      abortSignal: controller.signal,
      repairToolCall: request.repairData ? buildRepair(request) : undefined,
      onEvent,
    })
  } finally {
    endMediaAgentRun(request.runKey)
    activeRuns.delete(request.runKey)
  }
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
