import { z } from 'zod'
import { useImageGenerationPresets } from '../store/imageGenerationPresets'
import { useComfyUiPresets } from '../store/comfyUiPresets'
import { useActivities } from '../store/activities'
import { useConversations } from '../store/conversations'
import { useI18N } from '../store/i18n'
import { usePresets, type Preset, type ComfyUiPreset } from '../store/presets'
import { useTextInference } from '../store/textInference'
import { usePromptStore } from '../store/promptArea'
import { useDeveloperSettings } from '../store/developerSettings'
import { DEV_PRESET_NAMES, dummyWorkflowsOnly } from '../store/devPresets'
import { artifactKindForMedia, runArtifact } from '../artifact/runArtifact'
import { stopChatBackends, returnGpuToChat } from './chatBackends'
import { comfyRunsWaiting, queueComfyRun } from './mediaPipeline'
import {
  DEFAULT_RESOLUTION_CONFIG,
  getResolutionsFromConfig,
  getResolutionForConfig,
  findClosestResolutionInConfig,
} from '../store/imageGenerationUtils'
import type { ResolutionConfig, MegapixelOption } from '../store/presets'
import { isCancellation } from '../errors/appError'
import { tool } from 'ai'

// Helper function to get a sensible default megapixel tier from resolution config
function getDefaultMegapixelLabel(config: ResolutionConfig): string {
  const labels = config.megapixels.map((m: MegapixelOption) => m.label)
  // Prefer "1.0" if available (HD quality), otherwise pick middle tier
  if (labels.includes('1.0')) return '1.0'
  return labels[Math.floor(labels.length / 2)] ?? '0.5'
}

// Helper function to get available workflows for the tool
export function getAvailableWorkflows(): Array<{
  name: string
  mediaType?: 'image' | 'video' | 'model3d'
  description?: string
  toolInstructions?: string
  resolutions?: Array<{
    width: number
    height: number
    aspectRatio: string
    megapixels: string
    totalPixels: number
  }>
}> {
  const presets = usePresets()
  const textInference = useTextInference()

  return presets.presets
    .filter((preset: Preset) => {
      // Only ComfyUI presets
      if (preset.type !== 'comfy' || preset.backend !== 'comfyui') {
        return false
      }
      // Presets the create tool can drive from a prompt alone: images and
      // text-to-video. Image-to-video presets live behind the edit tool.
      if (preset.toolCategory !== 'create-images' && preset.toolCategory !== 'create-videos') {
        return false
      }
      // Dev-only override (Settings › Developer): offer only the instant dummy
      // workflows, so a verification run can't wander into a real model.
      if (dummyWorkflowsOnly()) return DEV_PRESET_NAMES.has(preset.name)
      // Honour the per-workflow sub-checkboxes (Settings › Built-in tools).
      return textInference.isWorkflowPresetEnabled(preset.name)
    })
    .map((preset: Preset) => {
      const comfyPreset = preset as ComfyUiPreset
      const config = comfyPreset.resolutionConfig ?? DEFAULT_RESOLUTION_CONFIG
      const resolutions = getResolutionsFromConfig(config)

      return {
        name: preset.name,
        mediaType: preset.mediaType,
        description: preset.description,
        toolInstructions: preset.toolInstructions,
        resolutions,
      }
    })
}

// Helper function to get resolution examples for tool description
function getResolutionExamplesForWorkflow(workflowName: string): string {
  const workflows = getAvailableWorkflows()
  const workflow = workflows.find((w) => w.name === workflowName)
  if (!workflow?.resolutions || workflow.resolutions.length === 0) {
    return '512x512, 1024x1024'
  }

  // Get unique aspect ratios and pick one example from each major megapixel tier
  const examples: string[] = []
  const seenAspectRatios = new Set<string>()

  // Prioritize common aspect ratios: 1/1 (square), 16/9 (wide), 9/16 (tall)
  const priorityRatios = ['1/1', '16/9', '9/16']

  for (const ratio of priorityRatios) {
    // Find highest MP resolution for this ratio
    const resForRatio = workflow.resolutions
      .filter((r) => r.aspectRatio === ratio)
      .sort((a, b) => b.totalPixels - a.totalPixels)[0]

    if (resForRatio && !seenAspectRatios.has(ratio)) {
      examples.push(`${resForRatio.width}x${resForRatio.height}`)
      seenAspectRatios.add(ratio)
    }
  }

  return examples.slice(0, 5).join(', ')
}

const ImageOutputSchema = z.object({
  id: z.string(),
  type: z.literal('image'),
  imageUrl: z.string(),
  mode: z.literal('imageGen'),
  settings: z.record(z.string(), z.unknown()),
})

const VideoOutputSchema = z.object({
  id: z.string(),
  type: z.literal('video'),
  videoUrl: z.string(),
  mode: z.literal('imageGen'),
  settings: z.record(z.string(), z.unknown()),
})

const Model3DOutputSchema = z.object({
  id: z.string(),
  type: z.literal('model3d'),
  model3dUrl: z.string(),
  mode: z.literal('imageGen'),
  settings: z.record(z.string(), z.unknown()),
})

const MediaOutputSchema = z.discriminatedUnion('type', [
  ImageOutputSchema,
  VideoOutputSchema,
  Model3DOutputSchema,
])

export const ComfyUiToolOutputSchema = z
  .object({
    images: z.array(MediaOutputSchema),
    // Optional fields for error handling
    success: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough()

export type ComfyUiToolOutput = z.infer<typeof ComfyUiToolOutputSchema>

// Helper function to find Fast variant in a preset
function findFastVariant(preset: Preset): string | null {
  if (!preset.variants || preset.variants.length === 0) return null
  const fastVariant = preset.variants.find((v) => v.name.toLowerCase().includes('fast'))
  return fastVariant ? fastVariant.name : null
}

type ComfyGenerationArgs = {
  workflow?: string
  variant?: string
  prompt: string
  negativePrompt?: string
  aspectRatio?: string
  megapixels?: string
  resolution?: string
  inferenceSteps?: number
  seed?: number
  batchSize?: number
}

/**
 * Runs one generation for a tool call. ComfyUI serves prompts one at a time and
 * the whole run drives the single global generation store (item tracking and
 * readiness phases live in the artifact runner), so concurrent callers queue
 * rather than interleave — see mediaPipeline.ts.
 */
export function executeComfyGeneration(
  args: ComfyGenerationArgs,
  options: { abortSignal?: AbortSignal } = {},
): Promise<ComfyUiToolOutput> {
  return queueComfyRun(() => runComfyGeneration(args, options), options.abortSignal)
}
async function runComfyGeneration(
  args: ComfyGenerationArgs,
  options: { abortSignal?: AbortSignal } = {},
): Promise<ComfyUiToolOutput> {
  const activities = useActivities()
  const conversations = useConversations()
  const i18nState = useI18N().state
  const imageGeneration = useImageGenerationPresets()
  const comfyUi = useComfyUiPresets()
  const presets = usePresets()

  // Surface the whole tool call as a chat activity ("Generating image…") and let
  // the runner nest the image-gen FSM phases under it (via parentActivityId)
  // so the chat status line shows live progress instead of a silent wait.
  const toolActivityId = activities.begin({
    category: 'tools',
    label: i18nState.COM_ACTIVITY_GENERATING_IMAGE,
    scope: { kind: 'chat', conversationKey: conversations.activeKey },
  })
  let toolActivityEnded = false
  const finishToolActivity = (state: 'done' | 'failed' = 'done') => {
    if (toolActivityEnded) return
    toolActivityEnded = true
    imageGeneration.generationParentActivityId = null
    activities.end(toolActivityId, state)
  }

  // Helper to create error result instead of throwing
  const createErrorResult = (message: string): ComfyUiToolOutput => {
    finishToolActivity('failed')
    return {
      success: false,
      message,
      images: [],
    }
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

  // Resolve the workflow: the tool catalog (enabled presets, dev-only dummy
  // override) decides what is drivable from a prompt alone.
  const availableWorkflows = getAvailableWorkflows()
  const imageWorkflowNames = availableWorkflows
    .filter((w) => w.mediaType !== 'video')
    .map((w) => w.name)
  const requestedWorkflow = args.workflow || resolveDefaultImageWorkflow(imageWorkflowNames)

  const preset = presets.presets.find(
    (p: Preset) => p.name === requestedWorkflow && p.type === 'comfy' && p.backend === 'comfyui',
  )
  if (!preset) {
    return createErrorResult(`Workflow "${requestedWorkflow}" is not available`)
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

  // Map the model's size vocabulary (aspectRatio/megapixels/resolution) onto a
  // concrete WxH. When the args carry no size, the runner applies the preset's
  // default resolution.
  const comfyPreset = preset as ComfyUiPreset
  const resolutionConfig = comfyPreset.resolutionConfig ?? DEFAULT_RESOLUTION_CONFIG

  let width: number | undefined
  let height: number | undefined

  if (args.aspectRatio || args.megapixels) {
    const ar = args.aspectRatio ?? '1/1'
    const mp = args.megapixels ?? getDefaultMegapixelLabel(resolutionConfig)

    const exactMatch = getResolutionForConfig(resolutionConfig, mp, ar)
    if (exactMatch) {
      width = exactMatch.width
      height = exactMatch.height
    } else {
      const allResolutions = getResolutionsFromConfig(resolutionConfig)
      const matchingAR = allResolutions.filter((r) => r.aspectRatio === ar)

      if (matchingAR.length > 0) {
        const targetMP = parseFloat(mp)
        const closest = matchingAR.reduce((prev, curr) => {
          const prevDiff = Math.abs(parseFloat(prev.megapixels) - targetMP)
          const currDiff = Math.abs(parseFloat(curr.megapixels) - targetMP)
          return currDiff < prevDiff ? curr : prev
        })
        width = closest.width
        height = closest.height
      }
      // Aspect ratio not in the config: leave unset — the runner falls back to
      // the preset's default resolution rather than the UI's live form.
    }
  } else if (args.resolution) {
    const [w, h] = args.resolution.split('x').map(Number)
    if (w && h) {
      const closestMatch = findClosestResolutionInConfig(resolutionConfig, w, h)
      if (closestMatch) {
        width = closestMatch.width
        height = closestMatch.height
      } else {
        width = w
        height = h
      }
    }
    // Unparseable resolution: leave unset for the preset default.
  }

  try {
    const result = await runArtifact(
      {
        kind: artifactKindForMedia(comfyPreset.mediaType, false),
        workflow: preset.name,
        variant,
        // The tool's output schema is imageGen-tagged regardless of media type.
        mode: 'imageGen',
        prompt: args.prompt,
        negativePrompt: args.negativePrompt,
        params: {
          seed: args.seed,
          width,
          height,
          inferenceSteps: args.inferenceSteps,
          batchSize: args.batchSize,
        },
      },
      { parentActivityId: toolActivityId, abortSignal: options.abortSignal },
    )

    if (result.state === 'cancelled') {
      finishToolActivity('failed')
      return { success: false, message: 'Generation cancelled.', images: [] }
    }
    if (result.state === 'failed') {
      return createErrorResult(`ComfyUI generation failed: ${result.error ?? 'unknown error'}`)
    }

    const images = result.items.map((item) => {
      const settings = item.settings || {}
      if (item.type === 'video') {
        return {
          id: item.id,
          type: 'video' as const,
          videoUrl: item.videoUrl,
          mode: 'imageGen' as const,
          settings,
        }
      }
      if (item.type === 'model3d') {
        return {
          id: item.id,
          type: 'model3d' as const,
          model3dUrl: item.model3dUrl,
          mode: 'imageGen' as const,
          settings,
        }
      }
      return {
        id: item.id,
        type: 'image' as const,
        imageUrl: item.imageUrl,
        mode: 'imageGen' as const,
        settings,
      }
    })
    return { images }
  } catch (error) {
    // Reset prompt state on error (matches the UI submit path's recovery).
    usePromptStore().promptSubmitted = false

    // A user cancelling a required model download is not a tool failure — report
    // it back to the model as a benign cancellation (the finally still cleans up).
    if (isCancellation(error)) {
      finishToolActivity('failed')
      return {
        success: false,
        message: 'Image generation was cancelled by the user.',
        images: [],
      }
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return createErrorResult(`ComfyUI generation failed: ${errorMessage}`)
  } finally {
    // Keep the activity alive through cleanup so the post-generation window (which
    // frees the GPU and restarts the chat backend — several seconds) isn't silent.
    // Relabel it to reflect what's actually happening before the LLM responds.
    // Nothing to hand back to while the queue still holds generations: they want
    // ComfyUI loaded and have no use for the LLM (see comfyRunsWaiting).
    if (!useDeveloperSettings().keepModelsLoaded && !comfyRunsWaiting()) {
      activities.update(toolActivityId, { label: i18nState.COM_ACTIVITY_RELOADING_CHAT })
      await returnGpuToChat(() => comfyUi.free())
    }
    finishToolActivity()
  }
}

// Tool definition for AI SDK
// Generate the tool description and schema dynamically based on available workflows
// User-selectable defaults, resolved per output media type from the enabled
// presets. These are standalone, explicitly-typed helpers on purpose: keeping the
// heavy `useTextInference()` store type out of `getToolDefinition` (whose inferred
// shape feeds the ai-SDK `tool()` generics) avoids a type-instantiation blow-up.
export function resolveDefaultImageWorkflow(imageNames: string[]): string {
  return useTextInference().getDefaultWorkflow('comfyUI:image', imageNames) ?? 'Draft Image'
}

/**
 * Repair a malformed comfyUI (create-image) tool call before execution: if the
 * model omitted `workflow` or sent a value that isn't a known workflow, coerce
 * it to the default image workflow. Returns the repaired args as a JSON string,
 * or null when `workflow` is already valid (nothing to fix) or none exist.
 * Wired into streamText's experimental_repairToolCall so a bad workflow can't
 * surface as an "unknown" tool card / failed generation.
 */
export function repairCreateToolInput(rawInput: string): string | null {
  const workflows = getAvailableWorkflows()
  if (workflows.length === 0) return null
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(rawInput || '{}')
    obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    obj = {}
  }
  const names = workflows.map((w) => w.name)
  if (typeof obj.workflow === 'string' && names.includes(obj.workflow)) return null
  const imageNames = workflows.filter((w) => w.mediaType !== 'video').map((w) => w.name)
  obj.workflow = resolveDefaultImageWorkflow(imageNames)
  return JSON.stringify(obj)
}

function resolveDefaultVideoWorkflow(videoNames: string[]): string | null {
  return useTextInference().getDefaultWorkflow('comfyUI:video', videoNames)
}

// Human-readable "<preset> - <Fast variant>" hint for the default image workflow,
// so the description keeps recommending the least-costly variant.
function resolveWorkflowVariantHint(workflowName: string): string {
  const preset = usePresets().presets.find((p) => p.name === workflowName)
  const fast = preset ? findFastVariant(preset) : null
  return fast ? `${workflowName} - ${fast}` : workflowName
}

function getToolDefinition() {
  const availableWorkflows = getAvailableWorkflows()

  const imageNames = availableWorkflows.filter((w) => w.mediaType !== 'video').map((w) => w.name)
  const videoNames = availableWorkflows.filter((w) => w.mediaType === 'video').map((w) => w.name)
  const defaultWorkflow = resolveDefaultImageWorkflow(imageNames)
  const defaultVideoWorkflow = resolveDefaultVideoWorkflow(videoNames)
  const defaultWorkflowWithVariant = resolveWorkflowVariantHint(defaultWorkflow)

  // Get resolution examples for the default workflow
  const defaultResolutionExamples = getResolutionExamplesForWorkflow(defaultWorkflow)

  // Fallback if no workflows are available yet (presets not loaded)
  if (availableWorkflows.length === 0) {
    return {
      description:
        'Use this tool to create, edit, or enhance media content (images, videos, or 3D models) based on text prompts. Only use this tool if the user explicitly asks to create media content.\n\n' +
        'IMPORTANT: Always generate a detailed, descriptive prompt even if the user provides a simple request. Expand simple requests into full prompts with subject details, composition, style, lighting, colors, mood, and quality tags.\n\n' +
        'VARIANT SUPPORT: Presets may have variants (e.g., "Fast", "Standard", "Quality"). By default, always prefer "Fast" variants when available as they are least resource intensive.\n\n' +
        'RESOLUTION: Specify image size using EITHER:\n' +
        '  - aspectRatio + megapixels (e.g., aspectRatio="16/9", megapixels="1.0")\n' +
        '  - OR resolution directly (e.g., resolution="1376x768")\n' +
        'Available aspect ratios: 1/1 (square), 16/9 (widescreen), 9/16 (portrait), 3/2, 2/3, 4/3, 3/4, 21/9, 9/21\n' +
        'Available megapixels: 0.25 (small), 0.5 (medium), 0.8, 1.0 (HD), 1.2, 1.5 (high-res)\n\n' +
        'CRITICAL: Do NOT include resolution, aspect ratio, dimensions, or size information in the prompt text itself. These should ONLY be passed as separate parameters (aspectRatio, megapixels, or resolution).',
      inputSchema: z.object({
        workflow: z
          .string()
          .describe(
            `Workflow name to use for generation. Use ${defaultWorkflow} (default, will automatically use "Fast" variant if available, least resource intensive) unless user specifically requests higher quality or different model.`,
          ),
        variant: z
          .string()
          .optional()
          .describe(
            'Optional variant name to use (e.g., "Fast", "Standard", "Quality"). If not specified, "Fast" variant will be used by default when available. Only specify if user explicitly requests a specific quality level.',
          ),
        prompt: z
          .string()
          .describe(
            'Detailed text prompt describing the media to generate. Always expand simple requests into full, descriptive prompts with subject details, composition, style, lighting, colors, mood, and quality tags. Do NOT include resolution or size information in the prompt.',
          ),
        negativePrompt: z.string().optional().describe('Negative prompt for things to avoid'),
        aspectRatio: z
          .string()
          .optional()
          .describe(
            'Aspect ratio for the image. Options: "1/1" (square), "16/9" (widescreen/landscape), "9/16" (portrait/vertical), "3/2", "2/3", "4/3", "3/4", "21/9" (ultra-wide), "9/21". Use with megapixels parameter.',
          ),
        megapixels: z
          .string()
          .optional()
          .describe(
            'Megapixel tier for image quality/size. Options: "0.25" (small), "0.5" (medium), "0.8", "1.0" (HD), "1.2", "1.5" (high-res). Use with aspectRatio parameter. Higher = better quality but slower.',
          ),
        resolution: z
          .string()
          .optional()
          .describe(
            `Direct resolution in WxH format (alternative to aspectRatio+megapixels). Examples: ${defaultResolutionExamples}. The closest valid resolution will be selected.`,
          ),
        seed: z
          .number()
          .optional()
          .describe(
            'Random seed for reproducible generation. Use -1 for random seed. Only specify if user wants to reproduce a specific result.',
          ),
        batchSize: z
          .number()
          .describe('Number of images to generate. Use 1 if not explicitly specified by the user.'),
      }),
    }
  }

  // Separate workflows by media type
  const videoWorkflows = availableWorkflows.filter((w) => w.mediaType === 'video')
  const imageWorkflows = availableWorkflows.filter((w) => w.mediaType === 'image' || !w.mediaType)

  // Build workflow description with available options
  const workflowOptions = availableWorkflows
    .map((w) => {
      const mediaTypeStr = w.mediaType ? ` (${w.mediaType})` : ''
      let isDefault = ''
      if (w.name === defaultWorkflow) isDefault = ' (default, least resource intensive)'
      else if (w.name === defaultVideoWorkflow) isDefault = ' (default video)'
      return `${w.name}${mediaTypeStr}${isDefault}`
    })
    .join(', ')

  // Add preset-specific instructions with clear preset -> instruction mapping
  const presetsWithInstructions = availableWorkflows.filter((w) => w.toolInstructions)

  // Base description with prompt generation instructions
  let description =
    'Use this tool to create, edit, or enhance media content (images, videos, or 3D models) based on text prompts. Only use this tool if the user explicitly asks to create media content.\n\n'
  description +=
    'IMPORTANT: Always generate a detailed, descriptive prompt even if the user provides a simple request. Expand simple requests into full prompts with subject details, composition, style, lighting, colors, mood, and quality tags. For example, if the user asks for "an elephant", expand it to something like "a majestic African elephant standing in golden hour sunlight, detailed wrinkles on skin, photorealistic, 8k, highly detailed, professional photography".\n\n'
  description += `VARIANT SUPPORT: Presets may have variants (e.g., "Fast", "Standard", "Quality"). By default, always prefer "Fast" variants when available as they are least resource intensive. The default preset is "${defaultWorkflow}" (equivalent to "${defaultWorkflowWithVariant}"). The tool will automatically select the "Fast" variant when available. You can optionally specify a variant name in the variant parameter if the user requests a specific quality level.\n\n`

  // Add resolution guidance
  description += 'RESOLUTION: Specify image size using EITHER:\n'
  description +=
    '  - aspectRatio + megapixels parameters (recommended): e.g., aspectRatio="16/9", megapixels="1.0"\n'
  description += '  - OR resolution parameter directly: e.g., resolution="1376x768"\n\n'
  description +=
    'Available aspect ratios: 1/1 (square), 16/9 (widescreen/landscape), 9/16 (portrait/vertical), 3/2, 2/3, 4/3, 3/4, 21/9 (ultra-wide), 9/21\n'
  description +=
    'Available megapixels: 0.25 (small/fast), 0.5 (medium), 0.8, 1.0 (HD), 1.2, 1.5 (high-res/slower)\n\n'
  description +=
    'When user asks for "high resolution", "HD", or "large" image, use megapixels="1.0" or higher.\n'
  description +=
    'When user asks for specific aspect ratio (e.g., "16:9", "widescreen", "landscape"), set aspectRatio accordingly.\n\n'
  description +=
    'CRITICAL: Do NOT include resolution, aspect ratio, dimensions, or size information in the prompt text itself. These should ONLY be passed as separate parameters (aspectRatio, megapixels, or resolution).\n\n'

  // Add preset-specific instructions if available
  if (presetsWithInstructions.length > 0) {
    description += 'Preset-specific prompt guidelines:\n'
    for (const preset of presetsWithInstructions) {
      description += `- ${preset.name}: ${preset.toolInstructions}\n`
    }
    description += '\n'
  }

  description += `Available workflows: ${workflowOptions}. `
  description += `IMPORTANT: You MUST use '${defaultWorkflow}' (which will automatically use the "Fast" variant, equivalent to '${defaultWorkflowWithVariant}') unless the user explicitly requests higher quality, a different model, or a different media type.\n\n`

  // Add explicit warnings for video workflows
  if (videoWorkflows.length > 0) {
    description += `IMPORTANT: Video workflows (${videoWorkflows.map((w) => w.name).join(', ')}) should ONLY be used when the user explicitly requests video generation. Never use video workflows for image requests. Video generation is resource-intensive and should only be used when specifically asked for.`
    if (defaultVideoWorkflow) {
      description += ` When the user asks for a video, prefer '${defaultVideoWorkflow}' unless they request a different video workflow.`
    }
  }

  // Build workflow enum or string description
  const workflowNames = availableWorkflows.map((w) => w.name)
  const workflowEnum =
    workflowNames.length > 0 ? z.enum(workflowNames as [string, ...string[]]) : z.string()

  let workflowDescription = `Workflow name to use for generation. Available options: ${workflowOptions}. `
  workflowDescription += `Use ${defaultWorkflow} (will automatically use "Fast" variant if available, equivalent to '${defaultWorkflowWithVariant}') unless user specifically requests higher quality or different model. `
  if (videoWorkflows.length > 0) {
    workflowDescription += `IMPORTANT: Only use video workflows (${videoWorkflows.map((w) => w.name).join(', ')}) when the user explicitly asks for video generation. Never use video workflows for image requests.`
  }

  // Build resolution description with examples from available workflows
  const resolutionExamples =
    imageWorkflows.length > 0
      ? getResolutionExamplesForWorkflow(imageWorkflows[0].name)
      : defaultResolutionExamples

  const resolutionDescription = `Direct resolution in WxH format (alternative to aspectRatio+megapixels). Examples: ${resolutionExamples}. The closest valid resolution will be selected.`

  return {
    description,
    inputSchema: z.object({
      workflow: workflowEnum.describe(workflowDescription),
      variant: z
        .string()
        .optional()
        .describe(
          'Optional variant name to use (e.g., "Fast", "Standard", "Quality"). If not specified, "Fast" variant will be used by default when available. Only specify if user explicitly requests a specific quality level.',
        ),
      prompt: z
        .string()
        .describe(
          'Detailed text prompt describing the media to generate. Always expand simple requests into full, descriptive prompts with subject details, composition, style, lighting, colors, mood, and quality tags. Do NOT include resolution or size information in the prompt.',
        ),
      negativePrompt: z.string().optional().describe('Negative prompt for things to avoid'),
      aspectRatio: z
        .string()
        .optional()
        .describe(
          'Aspect ratio for the image. Options: "1/1" (square), "16/9" (widescreen/landscape), "9/16" (portrait/vertical), "3/2", "2/3", "4/3", "3/4", "21/9" (ultra-wide), "9/21". Use with megapixels parameter.',
        ),
      megapixels: z
        .string()
        .optional()
        .describe(
          'Megapixel tier for image quality/size. Options: "0.25" (small/fast), "0.5" (medium), "0.8", "1.0" (HD), "1.2", "1.5" (high-res/slower). Use with aspectRatio parameter.',
        ),
      resolution: z.string().optional().describe(resolutionDescription),
      seed: z
        .number()
        .optional()
        .describe(
          'Random seed for reproducible generation. Use -1 for random seed. Only specify if user wants to reproduce a specific result.',
        ),
      batchSize: z
        .number()
        .describe('Number of images to generate. Use 1 if not explicitly specified by the user.'),
    }),
  }
}

// Tool definition for AI SDK
// Use getters so the tool definition is computed when accessed (after presets are loaded)
export const comfyUI = tool({
  get description() {
    return getToolDefinition().description
  },
  get inputSchema() {
    return getToolDefinition().inputSchema
  },
  outputSchema: ComfyUiToolOutputSchema,
  execute: async (
    args: {
      workflow?: string
      variant?: string
      prompt: string
      negativePrompt?: string
      aspectRatio?: string
      megapixels?: string
      resolution?: string
      inferenceSteps?: number
      seed?: number
      batchSize?: number
    },
    { abortSignal }: { abortSignal?: AbortSignal },
  ) => {
    return await executeComfyGeneration(args, { abortSignal })
  },
})
