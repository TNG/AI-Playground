import { z } from 'zod'
import { repairWorkflowToolInput } from '@/lib/comfyToolRepair'
import { FilePart, ModelMessage, tool } from 'ai'
import { useImageGenerationPresets } from '../store/imageGenerationPresets'
import { useComfyUiPresets } from '../store/comfyUiPresets'
import { useActivities } from '../store/activities'
import { useConversations } from '../store/conversations'
import { useI18N } from '../store/i18n'
import { usePresets, type Preset } from '../store/presets'
import { useTextInference } from '../store/textInference'
import { usePromptStore } from '../store/promptArea'
import { useDeveloperSettings } from '../store/developerSettings'
import { DEV_PRESET_NAMES, dummyWorkflowsOnly } from '../store/devPresets'
import { artifactKindForMedia, runArtifact } from '../artifact/runArtifact'
import { stopChatBackends, returnGpuToChat } from './chatBackends'
import { comfyRunsWaiting, queueComfyRun } from './mediaPipeline'
import { isCancellation } from '../errors/appError'

const ImageEditImageOutputSchema = z.object({
  id: z.string(),
  type: z.literal('image'),
  imageUrl: z.string(),
  mode: z.literal('imageEdit'),
  settings: z.record(z.string(), z.unknown()),
})

const ImageEditVideoOutputSchema = z.object({
  id: z.string(),
  type: z.literal('video'),
  videoUrl: z.string(),
  mode: z.literal('imageEdit'),
  settings: z.record(z.string(), z.unknown()),
})

const ImageEditModel3DOutputSchema = z.object({
  id: z.string(),
  type: z.literal('model3d'),
  model3dUrl: z.string(),
  mode: z.literal('imageEdit'),
  settings: z.record(z.string(), z.unknown()),
})

// Edit-category workflows can yield images (e.g. "Edit By Prompt") or other
// media (e.g. "Image To 3D Model" → model3d). Mirror the multi-media output
// of the create-images `comfyUI` tool so 3D / video edit workflows can
// actually complete their tool call.
const ImageEditMediaOutputSchema = z.discriminatedUnion('type', [
  ImageEditImageOutputSchema,
  ImageEditVideoOutputSchema,
  ImageEditModel3DOutputSchema,
])

export const ImageEditToolOutputSchema = z
  .object({
    images: z.array(ImageEditMediaOutputSchema),
    success: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough()

export type ImageEditToolOutput = z.infer<typeof ImageEditToolOutputSchema>

function convertFilePartToDataUrl(data: FilePart['data']): string {
  if (typeof data === 'string' && data.startsWith('data:image/')) {
    return data
  }
  console.error('[ComfyUIImageEdit Tool] Unsupported file part data format:', data)
  throw new Error('Only data URL images are supported')
}

// Helper to extract images from tool result output
// Handles JSON output structure: { type: "json", value: { images: [...] } }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractImageGenToolResult(part: any): { type?: string; imageUrl?: string } | null {
  const result = part.output ?? part.result
  if (!result) return null

  const images = result.type === 'json' ? result.value?.images : null
  if (!images) return null

  return (
    images.find(
      (img: { type?: string; imageUrl?: string }) => img.type === 'image' && img.imageUrl,
    ) ?? null
  )
}

// Check if the user dragged/attached an image into the current prompt (last user message).
// This takes priority over any other image in the conversation.
function findImageInCurrentPrompt(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue

    const imagePart = (msg.content as Array<{ type: string; mediaType?: string }>).findLast(
      (part): part is FilePart =>
        part.type === 'file' && part.mediaType?.startsWith('image/') === true,
    )
    if (imagePart) {
      console.log('[ComfyUIImageEdit Tool] Found image in current user prompt')
      return convertFilePartToDataUrl(imagePart.data)
    }
    // Found the last user message but it has no image - stop looking
    break
  }
  return null
}

// Walk backwards through conversation to find the most recent image regardless of source.
// Checks each message for either a generated image (tool result) or an uploaded image (user file),
// returning whichever appears latest in the conversation.
function findLatestImageInConversation(messages: ModelMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!Array.isArray(msg.content)) continue

    // Check tool result messages for generated images
    if (msg.role === 'tool') {
      for (const part of msg.content) {
        if (
          part.type === 'tool-result' &&
          // 'media' is the thin delegation tool (tools/media.ts): its
          // model-facing output carries the same slim `images` array, so a
          // follow-up edit can chain off a delegated generation.
          (part.toolName === 'comfyUI' ||
            part.toolName === 'comfyUiImageEdit' ||
            part.toolName === 'media')
        ) {
          const image = extractImageGenToolResult(part)
          if (image?.imageUrl) return image.imageUrl
        }
      }
    }

    // Check user messages for uploaded images
    if (msg.role === 'user') {
      const imagePart = (msg.content as Array<{ type: string; mediaType?: string }>).findLast(
        (part): part is FilePart =>
          part.type === 'file' && part.mediaType?.startsWith('image/') === true,
      )
      if (imagePart) return convertFilePartToDataUrl(imagePart.data)
    }
  }
  return null
}

// Image selection priority:
// 1. Image dragged into the current prompt (explicit user intent)
// 2. Most recent image in conversation by message position (generated or uploaded)
export function findSourceImage(messages: ModelMessage[]): string | null {
  return findImageInCurrentPrompt(messages) ?? findLatestImageInConversation(messages)
}

export function getAvailableEditWorkflows(): Array<{
  name: string
  mediaType?: 'image' | 'video' | 'model3d'
  description?: string
  toolInstructions?: string
}> {
  const presets = usePresets()
  const textInference = useTextInference()
  return presets.presets
    .filter((p: Preset) => {
      if (!(p.type === 'comfy' && p.backend === 'comfyui')) return false
      if (p.toolCategory !== 'edit-images') return false
      // Dev-only override (Settings › Developer): offer only the instant dummy
      // workflows, so a verification run can't wander into a real model.
      if (dummyWorkflowsOnly()) return DEV_PRESET_NAMES.has(p.name)
      // Honour the per-workflow sub-checkboxes (Settings › Built-in tools).
      return textInference.isWorkflowPresetEnabled(p.name)
    })
    .map((p: Preset) => ({
      name: p.name,
      mediaType: p.mediaType,
      description: p.description,
      toolInstructions: p.toolInstructions,
    }))
}

function findFastVariant(preset: Preset): string | null {
  const fast = preset.variants?.find((v) => v.name.toLowerCase().includes('fast'))
  return fast?.name || null
}

type ImageEditArgs = {
  workflow: string
  variant?: string
  prompt: string
  negativePrompt?: string
  seed?: number
}

const createErrorResult = (message: string): ImageEditToolOutput => ({
  success: false,
  message,
  images: [],
})

/**
 * Runs one edit for a tool call. Shares ComfyUI and the global generation store
 * with every other media run, so concurrent callers queue — see mediaPipeline.ts.
 */
export function executeImageEdit(
  args: ImageEditArgs,
  messages: ModelMessage[],
  options: { abortSignal?: AbortSignal } = {},
): Promise<ImageEditToolOutput> {
  return queueComfyRun(() => runImageEdit(args, messages, options), options.abortSignal)
}

async function runImageEdit(
  args: ImageEditArgs,
  messages: ModelMessage[],
  options: { abortSignal?: AbortSignal } = {},
): Promise<ImageEditToolOutput> {
  const activities = useActivities()
  const conversations = useConversations()
  const i18nState = useI18N().state
  const imageGeneration = useImageGenerationPresets()
  const comfyUi = useComfyUiPresets()
  const presets = usePresets()

  // Surface the tool call as a chat activity ("Editing image…") and let the
  // runner nest the image-gen FSM phases under it so the chat status line shows
  // live progress.
  const toolActivityId = activities.begin({
    category: 'tools',
    label: i18nState.COM_ACTIVITY_EDITING_IMAGE,
    scope: { kind: 'chat', conversationKey: conversations.activeKey },
  })
  let toolActivityEnded = false
  const finishToolActivity = (state: 'done' | 'failed' = 'done') => {
    if (toolActivityEnded) return
    toolActivityEnded = true
    imageGeneration.generationParentActivityId = null
    activities.end(toolActivityId, state)
  }

  if (!useDeveloperSettings().keepModelsLoaded) {
    // Wait for any in-flight chat stream (the request that carried this tool
    // call) to finish before freeing the GPU, so stopping the chat backend
    // can't reset an open llama.cpp socket mid-stream (=> "network error").
    // Replaces a fixed 100ms guess; bounded internally so a stuck stream can't
    // hang generation.
    await useTextInference().waitForInferenceIdle()
    await stopChatBackends()
  }

  // Image selection priority: dragged into the current prompt, else the most
  // recent image in the conversation (generated or uploaded).
  const sourceImageUrl = findSourceImage(messages)
  if (!sourceImageUrl) {
    finishToolActivity('failed')
    return createErrorResult(
      'No image found in conversation. Please upload an image or generate one first.',
    )
  }

  const preset = presets.presets.find(
    (p: Preset) =>
      p.name === args.workflow &&
      p.type === 'comfy' &&
      p.backend === 'comfyui' &&
      p.toolCategory === 'edit-images',
  )
  if (!preset) {
    return createErrorResult(`Edit workflow "${args.workflow}" is not available`)
  }

  // Variant preference is the driver's call: requested, else Fast, else first.
  let variant: string | undefined
  if (preset.variants?.length) {
    variant =
      (args.variant && preset.variants.some((v) => v.name === args.variant)
        ? args.variant
        : null) ||
      findFastVariant(preset) ||
      preset.variants[0].name
  }

  try {
    const result = await runArtifact(
      {
        kind: artifactKindForMedia(preset.mediaType, true),
        workflow: preset.name,
        variant,
        // The tool's output schema is imageEdit-tagged regardless of media type.
        mode: 'imageEdit',
        prompt: args.prompt,
        negativePrompt: args.negativePrompt,
        source: sourceImageUrl,
        // One result per edit — alternates make no sense when the output is a
        // transformed version of the input.
        params: { seed: args.seed, batchSize: 1 },
      },
      { parentActivityId: toolActivityId, abortSignal: options.abortSignal },
    )

    if (result.state === 'cancelled') {
      finishToolActivity('failed')
      return { success: false, message: 'Image edit cancelled.', images: [] }
    }
    if (result.state === 'failed') {
      return createErrorResult(`Image edit failed: ${result.error ?? 'unknown error'}`)
    }

    const completed = result.items[0]
    if (!completed) {
      return createErrorResult('Image edit produced no result')
    }
    const settings = completed.settings || {}
    if (completed.type === 'video') {
      return {
        images: [
          {
            id: completed.id,
            type: 'video',
            videoUrl: completed.videoUrl,
            mode: 'imageEdit',
            settings,
          },
        ],
      }
    }
    if (completed.type === 'model3d') {
      return {
        images: [
          {
            id: completed.id,
            type: 'model3d',
            model3dUrl: completed.model3dUrl,
            mode: 'imageEdit',
            settings,
          },
        ],
      }
    }
    return {
      images: [
        {
          id: completed.id,
          type: 'image',
          imageUrl: completed.imageUrl,
          mode: 'imageEdit',
          settings,
        },
      ],
    }
  } catch (error) {
    // Reset prompt state on error (matches the UI submit path's recovery).
    usePromptStore().promptSubmitted = false

    // A user cancelling a required model download is not a tool failure — report
    // it back to the model as a benign cancellation (the finally still cleans up).
    if (isCancellation(error)) {
      finishToolActivity('failed')
      return {
        success: false,
        message: 'Image edit was cancelled by the user.',
        images: [],
      }
    }

    return createErrorResult(
      `Image edit failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  } finally {
    // Keep the activity alive through cleanup (GPU free + chat backend restart) so
    // the window before the LLM's final response isn't silent.
    // Queued generations want ComfyUI loaded and not the LLM, so the last run out
    // of the lane does the swapping back (see comfyRunsWaiting).
    if (!useDeveloperSettings().keepModelsLoaded && !comfyRunsWaiting()) {
      activities.update(toolActivityId, { label: i18nState.COM_ACTIVITY_RELOADING_CHAT })
      await returnGpuToChat(() => comfyUi.free())
    }
    finishToolActivity()
  }
}

// User-selectable defaults, resolved per output media type from the enabled edit
// presets. Standalone, explicitly-typed helpers keep the heavy `useTextInference()`
// store type out of `getToolDefinition` (whose inferred shape feeds the ai-SDK
// `tool()` generics), avoiding a type-instantiation blow-up.
function resolveDefaultEditWorkflow(imageNames: string[]): string {
  return (
    useTextInference().getDefaultWorkflow('comfyUiImageEdit:image', imageNames) ?? 'Edit By Prompt'
  )
}

/**
 * Repair a malformed comfyUiImageEdit tool call before execution: if the model
 * omitted `workflow` or sent a value that isn't a known edit workflow, coerce it
 * to the default edit workflow. Returns the repaired args as a JSON string, or
 * null when `workflow` is already valid (nothing to fix) or none exist. Wired
 * into streamText's experimental_repairToolCall so a bad workflow can't surface
 * as an "unknown" tool card / failed edit.
 */
export function repairEditToolInput(rawInput: string): string | null {
  const data = createEditToolRepairData()
  return data ? repairWorkflowToolInput(rawInput, data) : null
}

/**
 * Edit-tool twin of `createToolRepairData` (comfyUi.ts): shipped as the turn
 * request's `repairData.comfyUiImageEdit` for the main-side turn engine.
 */
export function createEditToolRepairData():
  import('@/lib/comfyToolRepair').WorkflowRepairData | null {
  const workflows = getAvailableEditWorkflows()
  if (workflows.length === 0) return null
  const imageNames = workflows
    .filter((w) => (w.mediaType ?? 'image') === 'image')
    .map((w) => w.name)
  return {
    names: workflows.map((w) => w.name),
    defaultWorkflow: resolveDefaultEditWorkflow(imageNames),
  }
}

function resolveDefaultAnimateWorkflow(videoNames: string[]): string | null {
  return useTextInference().getDefaultWorkflow('comfyUiImageEdit:video', videoNames)
}

function resolveDefaultTo3DWorkflow(modelNames: string[]): string | null {
  return useTextInference().getDefaultWorkflow('comfyUiImageEdit:model3d', modelNames)
}

function getToolDefinition() {
  const workflows = getAvailableEditWorkflows()

  const imageNames = workflows
    .filter((w) => (w.mediaType ?? 'image') === 'image')
    .map((w) => w.name)
  const videoNames = workflows.filter((w) => w.mediaType === 'video').map((w) => w.name)
  const modelNames = workflows.filter((w) => w.mediaType === 'model3d').map((w) => w.name)
  const defaultEditWorkflow = resolveDefaultEditWorkflow(imageNames)
  const defaultAnimateWorkflow = resolveDefaultAnimateWorkflow(videoNames)
  const defaultTo3DWorkflow = resolveDefaultTo3DWorkflow(modelNames)

  const workflowOptions = workflows
    .map((w) => {
      const mediaTypeStr = w.mediaType && w.mediaType !== 'image' ? ` (${w.mediaType})` : ''
      let isDefault = ''
      if (w.name === defaultEditWorkflow) isDefault = ' (default)'
      else if (w.name === defaultAnimateWorkflow) isDefault = ' (default animate)'
      else if (w.name === defaultTo3DWorkflow) isDefault = ' (default 3D)'
      return w.name + mediaTypeStr + isDefault
    })
    .join(', ')

  const videoWorkflows = workflows.filter((w) => w.mediaType === 'video')

  let description =
    'Use this tool to transform an existing image from the conversation based on a text prompt. ' +
    'This tool takes the most recent image from the conversation (uploaded or generated) and applies the selected workflow - editing it, converting it to a 3D model, or animating it into a video.\n\n' +
    'IMPORTANT: This tool requires an image to already exist in the conversation.\n\n' +
    'VARIANT SUPPORT: Presets may have variants (e.g., "Fast", "Standard", "Quality"). By default, always prefer "Fast" variants when available as they are least resource intensive.\n\n'

  if (videoWorkflows.length > 0) {
    description += `IMAGE-TO-VIDEO: Workflows (${videoWorkflows
      .map((w) => w.name)
      .join(
        ', ',
      )}) animate the existing image into a short video. Only use them when the user explicitly asks to animate an image or create a video from it. Video generation is resource-intensive.\n\n`
  }

  // Add preset-specific tool instructions with clear preset -> instruction mapping
  const presetsWithInstructions = workflows.filter((w) => w.toolInstructions)
  if (presetsWithInstructions.length > 0) {
    description += 'Preset-specific prompt guidelines:\n'
    for (const preset of presetsWithInstructions) {
      description += `- ${preset.name}: ${preset.toolInstructions}\n`
    }
    description += '\n'
  }

  // Per-output-type defaults: what to reach for unless the user asks otherwise.
  description += `DEFAULTS: For editing an image, default to "${defaultEditWorkflow}".`
  if (defaultAnimateWorkflow) {
    description += ` To animate an image into a video, default to "${defaultAnimateWorkflow}".`
  }
  if (defaultTo3DWorkflow) {
    description += ` To convert an image into a 3D model, default to "${defaultTo3DWorkflow}".`
  }
  description += '\n\n'

  description += `Available edit workflows: ${workflowOptions}`

  const workflowNames = workflows.map((w) => w.name) as [string, ...string[]]

  let workflowDescription = `Edit workflow to use. Available: ${workflowOptions}. Use "${defaultEditWorkflow}" for image edits unless the user explicitly requests a different workflow.`
  if (defaultAnimateWorkflow) {
    workflowDescription += ` Use "${defaultAnimateWorkflow}" when animating an image into a video.`
  }
  if (defaultTo3DWorkflow) {
    workflowDescription += ` Use "${defaultTo3DWorkflow}" when converting an image into a 3D model.`
  }

  return {
    description,
    inputSchema: z.object({
      workflow: z.enum(workflowNames).describe(workflowDescription),
      variant: z
        .string()
        .optional()
        .describe(
          'Optional variant name (e.g., "Fast", "Standard", "Quality"). If not specified, "Fast" variant will be used by default when available.',
        ),
      prompt: z.string().describe('Description of the edit to apply to the image.'),
      negativePrompt: z.string().optional().describe('Things to avoid in the edit'),
      seed: z
        .number()
        .optional()
        .describe(
          'Random seed for reproducible generation. Use -1 for random seed. Only specify if user wants to reproduce a specific result.',
        ),
    }),
  }
}

export const comfyUiImageEdit = tool({
  get description() {
    return getToolDefinition().description
  },
  get inputSchema() {
    return getToolDefinition().inputSchema
  },
  outputSchema: ImageEditToolOutputSchema,
  execute: async (
    args: ImageEditArgs,
    { messages, abortSignal }: { messages: ModelMessage[]; abortSignal?: AbortSignal },
  ) => {
    return await executeImageEdit(args, messages, { abortSignal })
  },
})
