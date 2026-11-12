import { type ToolSet } from 'ai'
import { z } from 'zod'
import { comfyUI, comfyUIFor, getAvailableWorkflows, createToolRepairData } from '../tools/comfyUi'
import {
  comfyUiImageEdit,
  comfyUiImageEditFor,
  getAvailableEditWorkflows,
  createEditToolRepairData,
} from '../tools/comfyUiImageEdit'
import { useTextInference } from '../store/textInference'
import { serializeToolSet } from '@/lib/chatToolRegistry'
import type { ChatToolSpec, WorkflowRepairData } from '@/types/chatIpc'
import type { MediaToolSettings } from '@/lib/mediaToolSettings'

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
// catalog as tool specs.
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
    mode: z.string().default('imageGen'),
    settings: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough()

export type MediaAgentMedia = z.infer<typeof MediaAgentMediaSchema>

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
  '- If the user declined a model download, never call that workflow again: use another',
  '  workflow if one fits, otherwise stop and report that the download was declined.',
  '- When done, reply with a short plain-text report of what you created and which workflows',
  '  you used. Do not include URLs, file paths or markdown images — they are delivered',
  '  separately.',
].join('\n')

/**
 * Inner tool set. Reuses the real chat tools under their original names —
 * comfyUiImageEdit's source-image discovery keys off those names in the
 * nested message history (main ships that history into in-process edit).
 * Respects the same user gating as chat (per-tool toggles + per-workflow
 * sub-checkboxes). Schema only; main runs the tools in-process.
 */
function buildMediaAgentTools(settings?: MediaToolSettings): ToolSet {
  const isToolEnabled = settings?.isToolEnabled ?? useTextInference().isBuiltinToolEnabled
  const tools: ToolSet = {}
  if (isToolEnabled('comfyUI') && getAvailableWorkflows(settings?.isWorkflowEnabled).length > 0) {
    tools.comfyUI = settings ? comfyUIFor(settings) : comfyUI
  }
  if (
    isToolEnabled('comfyUiImageEdit') &&
    getAvailableEditWorkflows(settings?.isWorkflowEnabled).length > 0
  ) {
    tools.comfyUiImageEdit = settings ? comfyUiImageEditFor(settings) : comfyUiImageEdit
  }
  return tools
}

export type MediaAgentInnerTools = {
  system: string
  toolSpecs: ChatToolSpec[]
  repairData: {
    comfyUI?: WorkflowRepairData
    comfyUiImageEdit?: WorkflowRepairData
  }
}

/**
 * Inner catalog the specialist needs, frozen at the moment the parent asks.
 * `settings` defaults to the chat store's live media tool settings.
 */
export function serializeMediaAgentInner(
  settings?: MediaToolSettings,
): MediaAgentInnerTools | undefined {
  const tools = buildMediaAgentTools(settings)
  if (Object.keys(tools).length === 0) return undefined
  return {
    system: MEDIA_AGENT_SYSTEM,
    toolSpecs: serializeToolSet(tools),
    repairData: {
      ...(tools.comfyUI ? { comfyUI: createToolRepairData(settings) ?? undefined } : {}),
      ...(tools.comfyUiImageEdit
        ? { comfyUiImageEdit: createEditToolRepairData(settings) ?? undefined }
        : {}),
    },
  }
}

// Re-exported so callers (agent bridge) can pre-flight without running a turn.
// `settings` defaults to the chat store's live media tool settings.
export function mediaAgentHasTools(
  settings?: Pick<MediaToolSettings, 'isToolEnabled' | 'isWorkflowEnabled'>,
): boolean {
  const textInference = useTextInference()
  const isToolEnabled = settings?.isToolEnabled ?? textInference.isBuiltinToolEnabled
  const isWorkflowEnabled = settings?.isWorkflowEnabled
  return (
    (isToolEnabled('comfyUI') && getAvailableWorkflows(isWorkflowEnabled).length > 0) ||
    (isToolEnabled('comfyUiImageEdit') && getAvailableEditWorkflows(isWorkflowEnabled).length > 0)
  )
}
