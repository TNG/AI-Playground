import { tool, type ModelMessage, type ToolSet } from 'ai'
import { z } from 'zod'
import { comfyUI, getAvailableWorkflows, createToolRepairData } from '../tools/comfyUi'
import {
  comfyUiImageEdit,
  executeImageEdit,
  getAvailableEditWorkflows,
  createEditToolRepairData,
} from '../tools/comfyUiImageEdit'
import { useTextInference } from '../store/textInference'
import { useDeveloperSettings } from '../store/developerSettings'
import { useMediaAgentRuns } from '../store/mediaAgentRuns'
import type { MediaItem } from '../store/imageGenerationPresets'
import { imageUrlToDataUri } from '@/lib/utils'
import { buildChatModelConfig } from '@/lib/chatModel'
import { condenseMediaAgentRun, mediaEntriesOf } from '@/lib/mediaAgentResult'
import { serializeToolSet } from '@/lib/chatToolRegistry'
import type { ChatToolSpec, WorkflowRepairData } from '@/types/chatIpc'
import type { KernelMediaAgentEvent } from '@/types/kernelEvents'

// ── Media agent ───────────────────────────────────────────────────────────────
//
// The nested "media specialist": it owns the two heavy ComfyUI tools (whose
// descriptions carry the live workflow catalog, preset guidance and resolution
// rules — 1-2k tokens) and runs a short tool loop on the SAME model/endpoint
// as the parent conversation. The parent only sees the thin `media` tool and
// this agent's condensed result, so the catalog, tool schemas and intermediate
// tool payloads never enter (or pollute) the parent context.
//
// Inner Comfy executions run in main (step 12). This module ships the live
// catalog as tool specs and condenses the result.
//
// Chaining (e.g. "generate a castle image, then turn it into a 3D model")
// works through the nested conversation itself: comfyUiImageEdit discovers its
// source image from the message history, where the previous comfyUI tool
// result (with its aipg-media:// URL) already lives. A parent-provided source
// image (chat conversation image, or an Agent Mode workspace file) is injected
// as a leading user message carrying the image, so it acts as the fallback
// source when this run has not produced anything yet.

/** Comfy-shaped media entry (same wire shape the comfy tools return). */
export const MediaAgentMediaSchema = z
  .object({
    id: z.string(),
    type: z.enum(['image', 'video', 'model3d']),
    imageUrl: z.string().optional(),
    videoUrl: z.string().optional(),
    model3dUrl: z.string().optional(),
    mode: z.string(),
    settings: z.record(z.string(), z.unknown()),
  })
  .passthrough()

export type MediaAgentMedia = z.infer<typeof MediaAgentMediaSchema>

export type MediaAgentResult = {
  /** All media produced across the run, in creation order ("images" to match the comfy tool result shape consumed by the UI and the workspace saver). */
  images: MediaAgentMedia[]
  /** One human-readable line per inner tool call. */
  steps: string[]
  /** The specialist's own closing report. */
  summary: string
  success?: boolean
  message?: string
}

export type MediaAgentOptions = {
  /** The delegated request, verbatim. */
  request: string
  /**
   * Optional source image for transform requests: a data URI or an
   * aipg-media:// URL. Used when the run itself has not generated one yet.
   */
  sourceImage?: string
  /** The parent conversation key, when the run serves a chat turn. */
  conversationKey?: string
  abortSignal?: AbortSignal
  /**
   * Delegating tool call id. When set, the run reports live progress to the
   * mediaAgentRuns store so the UI can show a timeline while this call is
   * still pending.
   */
  runId?: string
}

const MEDIA_AGENT_SYSTEM = [
  'You are the media specialist of AI Playground. You receive one delegated media request,',
  'fulfill it with your tools, and report back. Do not ask questions — make sensible choices.',
  '',
  '- Use comfyUI to create images or videos from a text prompt.',
  '- Use comfyUiImageEdit to transform the most recent image: edit it, animate it into a video,',
  '  or convert it into a 3D model. The most recent image (generated earlier in this',
  '  conversation, or provided with the request) is picked up as the source automatically.',
  '- Chain tools when the request needs it, e.g. first generate an image with comfyUI, then',
  '  convert that image with comfyUiImageEdit.',
  '- Expand terse prompts into detailed, high-quality generation prompts (subject, composition,',
  '  style, lighting, mood, quality tags).',
  '- If a tool call fails with an actionable error, correct the parameters and retry once;',
  '  otherwise stop and report the failure.',
  '- When done, reply with a short plain-text report of what you created and which workflows',
  '  you used. Do not include URLs, file paths or markdown images — they are delivered',
  '  separately.',
].join('\n')

/**
 * Inner tool set. Reuses the real chat tools under their original names —
 * comfyUiImageEdit's source-image discovery keys off those names in the
 * nested message history (main ships that history into in-process edit).
 * Respects the same user gating as chat (per-tool toggles + per-workflow
 * sub-checkboxes). The execute closures here are only for schema serialization;
 * main runs the tools in-process.
 */
function buildMediaAgentTools(): ToolSet {
  const textInference = useTextInference()
  const tools: ToolSet = {}
  if (textInference.isBuiltinToolEnabled('comfyUI') && getAvailableWorkflows().length > 0) {
    tools.comfyUI = comfyUI
  }
  if (
    textInference.isBuiltinToolEnabled('comfyUiImageEdit') &&
    getAvailableEditWorkflows().length > 0
  ) {
    tools.comfyUiImageEdit = tool({
      description: comfyUiImageEdit.description,
      inputSchema: comfyUiImageEdit.inputSchema,
      outputSchema: comfyUiImageEdit.outputSchema,
      execute: async (args, options) => {
        return await executeImageEdit(
          args as Parameters<typeof executeImageEdit>[0],
          (options?.messages ?? []) as ModelMessage[],
        )
      },
    })
  }
  return tools
}

/** Comfy-shaped entries carry everything a MediaItem needs except its state. */
function toMediaItems(output: unknown): MediaItem[] {
  return mediaEntriesOf(output).map((item) => ({ ...item, state: 'done' }) as MediaItem)
}

/** Row title inputs for the timeline: which workflow, and with what prompt. */
function stepDescriptor(input: unknown): { workflow?: string; prompt?: string } {
  const record = (input ?? {}) as Record<string, unknown>
  return {
    workflow: typeof record.workflow === 'string' ? record.workflow : undefined,
    prompt: typeof record.prompt === 'string' ? record.prompt : undefined,
  }
}

/** Translates a run's kernel progress events into mediaAgentRuns store updates. */
function translateProgressEvent(runKey: string, event: KernelMediaAgentEvent['event']): void {
  const mediaRuns = useMediaAgentRuns()
  // Pi's in-process specialist never calls runMediaAgent, so the first kernel
  // event has to open the timeline row (request text is empty; the UI does
  // not show it).
  if (!mediaRuns.run(runKey)) mediaRuns.beginRun(runKey, '')
  switch (event.type) {
    case 'phase':
      mediaRuns.setPhase(runKey, event.phase)
      break
    case 'narration-delta':
      mediaRuns.appendNarration(runKey, event.text)
      break
    case 'tool-start':
      mediaRuns.beginStep(runKey, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        ...stepDescriptor(event.input),
        label: 'Starting…',
      })
      break
    case 'tool-finish': {
      const output = (event.output ?? {}) as { success?: boolean; message?: string }
      mediaRuns.endStep(runKey, {
        toolCallId: event.toolCallId,
        media: toMediaItems(event.output),
        error: event.error ?? (output.success === false ? output.message : undefined),
      })
      break
    }
  }
}

// The nested loop runs in main (step 6); its live progress reaches the
// timeline as `media-agent-event` kernel events. One listener serves every
// run, keyed by runKey — registered on first use so module import alone (and
// unit tests) never subscribes. Agent Mode also calls this on mount, because
// Pi's in-process `media` tool never goes through runMediaAgent.
let mediaKernelUnsubscribe: (() => void) | null = null
export function ensureMediaAgentEventWiring(): void {
  if (mediaKernelUnsubscribe) return
  const subscribe = window.electronAPI?.onKernelEvent
  if (!subscribe) return
  mediaKernelUnsubscribe = subscribe((event) => {
    if (event.type !== 'media-agent-event') return
    translateProgressEvent(event.runKey, event.event)
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    mediaKernelUnsubscribe?.()
    mediaKernelUnsubscribe = null
  })
}

export type MediaAgentInnerTools = {
  system: string
  toolSpecs: ChatToolSpec[]
  repairData: {
    comfyUI?: WorkflowRepairData
    comfyUiImageEdit?: WorkflowRepairData
  }
}

/** Inner catalog the specialist needs, frozen at the moment the parent asks. */
export function serializeMediaAgentInner(): MediaAgentInnerTools | undefined {
  const tools = buildMediaAgentTools()
  if (Object.keys(tools).length === 0) return undefined
  return {
    system: MEDIA_AGENT_SYSTEM,
    toolSpecs: serializeToolSet(tools),
    repairData: {
      ...(tools.comfyUI ? { comfyUI: createToolRepairData() ?? undefined } : {}),
      ...(tools.comfyUiImageEdit
        ? { comfyUiImageEdit: createEditToolRepairData() ?? undefined }
        : {}),
    },
  }
}

export async function runMediaAgent(options: MediaAgentOptions): Promise<MediaAgentResult> {
  const inner = serializeMediaAgentInner()
  if (!inner) {
    return {
      images: [],
      steps: [],
      summary: 'No media workflows are available.',
      success: false,
      message: 'No media workflows are available.',
    }
  }
  const runKey = options.runId ?? `media-run:${crypto.randomUUID()}`

  // Normalize the parent-provided source (aipg-media:// or data URI); main
  // prepends it as the leading file message of the nested history.
  const sourceImage = options.sourceImage ? await imageUrlToDataUri(options.sourceImage) : undefined

  const mediaRuns = useMediaAgentRuns()
  if (options.runId) mediaRuns.beginRun(options.runId, options.request)
  ensureMediaAgentEventWiring()

  const abortListener = () => {
    void window.electronAPI?.chat?.cancelMediaAgent?.(runKey)
  }
  options.abortSignal?.addEventListener('abort', abortListener, { once: true })
  try {
    const response = await window.electronAPI.chat.runMediaAgent({
      runKey,
      ...(options.conversationKey ? { conversationKey: options.conversationKey } : {}),
      request: options.request,
      ...(sourceImage !== undefined ? { sourceImage } : {}),
      system: inner.system,
      toolSpecs: inner.toolSpecs,
      repairData: inner.repairData,
      keepModelsLoaded: useDeveloperSettings().keepModelsLoaded,
      model: buildChatModelConfig(),
    })
    if (!response.success) throw new Error(response.error)
    const result: MediaAgentResult = condenseMediaAgentRun(response.data)
    if (options.runId) mediaRuns.endRun(options.runId, result.success === false ? 'failed' : 'done')
    return result
  } catch (error) {
    if (options.runId) mediaRuns.endRun(options.runId, 'failed')
    throw error
  } finally {
    options.abortSignal?.removeEventListener('abort', abortListener)
  }
}

// Re-exported so callers (agent bridge) can pre-flight without running a turn.
export function mediaAgentHasTools(): boolean {
  const textInference = useTextInference()
  return (
    (textInference.isBuiltinToolEnabled('comfyUI') && getAvailableWorkflows().length > 0) ||
    (textInference.isBuiltinToolEnabled('comfyUiImageEdit') &&
      getAvailableEditWorkflows().length > 0)
  )
}
