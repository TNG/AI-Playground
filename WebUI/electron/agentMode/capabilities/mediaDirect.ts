import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { submitArtifactRun, cancelArtifactRun } from '../../artifact/runner.ts'
import type { ArtifactRunResult } from '../../artifact/runner.ts'
import { withGpuForMedia } from '../../artifact/gpuOccupancy.ts'
import { resolveComfyEntry, type PresetCatalog } from '../../artifact/catalog.ts'
import { randomUUID } from 'node:crypto'
import type { ComfyInput, ComfyUiPreset, Preset } from '@/lib/presetSchemas'
import { OPTIONAL_MODEL_NONE } from '@/lib/comfyWorkflow'
import {
  DEFAULT_RESOLUTION_CONFIG,
  findClosestResolutionInConfig,
  getResolutionForConfig,
  getResolutionsFromConfig,
} from '@/lib/comfyResolutions'
import type { ResolutionConfig, MegapixelOption } from '@/lib/presetSchemas'
import {
  jsonResult,
  jsonSchemaParameters,
  saveGeneratedMediaToWorkspace,
  workspaceFileToDataUri,
} from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentToolSpec, CapabilityHost } from './types.ts'

// ── direct media tools, in-process ────────────────────────────────────────────
//
// `generateImage` / `editImage` executed beside the artifact runner in main
// (architecture-target §8 step 5): the workflow is resolved from main's preset
// catalog, the run submits through the same queue every driver uses, and the
// GPU swap brackets it (`withGpuForMedia`) — chat tools keep the renderer-side
// swap in chatBackends.ts, so both paths behave the same but never mix. Only
// the specs (descriptions, schemas, default workflow) are still shipped by the
// renderer, because which workflows are enabled is renderer settings.
//
// A run built here sets no `items` (the runner registers and streams them) and
// no `modelsConsented` (the runner asks the renderer's permissions layer itself).

type CatalogProvider = () => Promise<PresetCatalog>
let catalogProvider: CatalogProvider | null = null

/**
 * Wires how main resolves its preset catalog (bundle + user + dev dummies).
 * Set once from main's service wiring; tests install their own.
 */
export function setMediaCatalogProvider(provider: CatalogProvider): void {
  catalogProvider = provider
}

export function resetMediaCatalogProviderForTest(): void {
  catalogProvider = null
}

// Mirrors the renderer tools' variant preference (tools/comfyUi.ts): requested,
// else the Fast variant, else the first.
function findFastVariant(preset: Preset): string | null {
  if (!preset.variants || preset.variants.length === 0) return null
  const fastVariant = preset.variants.find((v) => v.name.toLowerCase().includes('fast'))
  return fastVariant ? fastVariant.name : null
}

function resolveVariant(preset: Preset, requested: unknown): string | undefined {
  if (typeof requested === 'string' && preset.variants?.some((v) => v.name === requested)) {
    return requested
  }
  return findFastVariant(preset) ?? preset.variants?.[0]?.name
}

function getDefaultMegapixelLabel(config: ResolutionConfig): string {
  const labels = config.megapixels.map((m: MegapixelOption) => m.label)
  if (labels.includes('1.0')) return '1.0'
  return labels[Math.floor(labels.length / 2)] ?? '0.5'
}

// The model's size vocabulary (aspectRatio/megapixels/resolution) mapped onto a
// concrete WxH, exactly like the renderer's create tool (tools/comfyUi.ts).
function resolveSize(
  preset: ComfyUiPreset,
  args: { aspectRatio?: unknown; megapixels?: unknown; resolution?: unknown },
): { width?: number; height?: number } {
  const config = preset.resolutionConfig ?? DEFAULT_RESOLUTION_CONFIG
  const aspectRatio = typeof args.aspectRatio === 'string' ? args.aspectRatio : undefined
  const megapixels = typeof args.megapixels === 'string' ? args.megapixels : undefined
  const resolution = typeof args.resolution === 'string' ? args.resolution : undefined

  if (aspectRatio || megapixels) {
    const ar = aspectRatio ?? '1/1'
    const mp = megapixels ?? getDefaultMegapixelLabel(config)
    const exact = getResolutionForConfig(config, mp, ar)
    if (exact) return { width: exact.width, height: exact.height }
    const matchingAR = getResolutionsFromConfig(config).filter((r) => r.aspectRatio === ar)
    if (matchingAR.length === 0) return {}
    const target = parseFloat(mp)
    const closest = matchingAR.reduce((prev, curr) =>
      Math.abs(parseFloat(curr.megapixels) - target) <
      Math.abs(parseFloat(prev.megapixels) - target)
        ? curr
        : prev,
    )
    return { width: closest.width, height: closest.height }
  }
  if (resolution) {
    const [w, h] = resolution.split('x').map(Number)
    if (w && h) {
      const match = findClosestResolutionInConfig(config, w, h)
      return match ? { width: match.width, height: match.height } : { width: w, height: h }
    }
  }
  return {}
}

/**
 * Dynamic inputs resolved from the preset alone: main has no saved
 * per-preset input map (the settings sidebar's values are renderer state), so
 * defaults apply — optional model inputs with no value resolve to the bypass
 * marker, and an edit's source is injected into the first required image input.
 */
function resolveInputs(
  preset: ComfyUiPreset,
  sourceDataUri?: string,
): Array<ComfyInput & { current: unknown }> {
  const inputs = preset.settings.filter(
    (s): s is ComfyInput => 'nodeTitle' in s && 'nodeInput' in s,
  )
  const resolved = inputs.map((input) => {
    const raw = input.defaultValue
    const current =
      input.type === 'model' &&
      input.optional === true &&
      (raw === undefined || raw === '' || raw === OPTIONAL_MODEL_NONE)
        ? OPTIONAL_MODEL_NONE
        : raw
    return { ...input, current }
  })
  if (sourceDataUri) {
    const imageInput = resolved.find(
      (input) =>
        (input.type === 'image' ||
          input.type === 'inpaintMask' ||
          input.type === 'outpaintCanvas') &&
        input.displayed !== false &&
        input.modifiable !== false &&
        (input.current === '' || input.current === undefined),
    )
    if (imageInput) imageInput.current = sourceDataUri
  }
  return resolved
}

/** Result shaped like the renderer tools' output: saveGeneratedMediaToWorkspace reads images[]. */
function toolOutput(result: ArtifactRunResult): Record<string, unknown> {
  const images = result.items.map((item) => {
    const settings = item.settings || {}
    if (item.type === 'video') {
      return { id: item.id, type: 'video', videoUrl: item.videoUrl, mode: 'imageGen', settings }
    }
    if (item.type === 'model3d') {
      return {
        id: item.id,
        type: 'model3d',
        model3dUrl: item.model3dUrl,
        mode: 'imageGen',
        settings,
      }
    }
    return { id: item.id, type: 'image', imageUrl: item.imageUrl, mode: 'imageGen', settings }
  })
  if (result.state === 'cancelled') {
    return { success: false, message: 'Generation cancelled.', images }
  }
  if (result.state === 'failed') {
    return {
      success: false,
      message: `ComfyUI generation failed: ${result.error ?? 'unknown error'}`,
      images,
    }
  }
  return { images }
}

type DirectArgs = {
  workflow?: unknown
  variant?: unknown
  prompt?: unknown
  negativePrompt?: unknown
  aspectRatio?: unknown
  megapixels?: unknown
  resolution?: unknown
  inferenceSteps?: unknown
  seed?: unknown
  batchSize?: unknown
  sourceImagePath?: unknown
}

async function runDirectTool(
  host: CapabilityHost,
  spec: AgentToolSpec,
  rawArgs: DirectArgs,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!catalogProvider) {
    return { success: false, message: 'No preset catalog is available in main.', images: [] }
  }
  const workflowName =
    typeof rawArgs.workflow === 'string' && rawArgs.workflow !== ''
      ? rawArgs.workflow
      : spec.defaultWorkflow
  if (!workflowName) {
    return {
      success: false,
      message: 'No workflow requested and none configured as default.',
      images: [],
    }
  }

  const catalog = await catalogProvider()
  const base = catalog.comfy.get(workflowName)
  if (!base) {
    return { success: false, message: `Workflow "${workflowName}" is not available.`, images: [] }
  }
  const variant = resolveVariant(base, rawArgs.variant)
  const preset = resolveComfyEntry(catalog, workflowName, variant)
  if (!preset) {
    return {
      success: false,
      message: `Workflow "${workflowName}" could not be resolved.`,
      images: [],
    }
  }

  const isEdit = spec.name === 'editImage'
  const { width, height } = isEdit ? {} : resolveSize(preset, rawArgs)
  const prompt = typeof rawArgs.prompt === 'string' ? rawArgs.prompt : ''

  const payload = {
    runId: randomUUID(),
    // The tool's output schema is mode-tagged regardless of media type, like
    // the renderer tools' runArtifact calls.
    mode: (isEdit ? 'imageEdit' : 'imageGen') as 'imageEdit' | 'imageGen',
    preset,
    params: {
      prompt,
      negativePrompt: typeof rawArgs.negativePrompt === 'string' ? rawArgs.negativePrompt : 'nsfw',
      seed: typeof rawArgs.seed === 'number' ? rawArgs.seed : -1,
      inferenceSteps: typeof rawArgs.inferenceSteps === 'number' ? rawArgs.inferenceSteps : 6,
      width: width ?? 512,
      height: height ?? 512,
      // One result per edit — alternates make no sense on a transformed input.
      batchSize: isEdit ? 1 : typeof rawArgs.batchSize === 'number' ? rawArgs.batchSize : 1,
    },
    inputs: resolveInputs(
      preset,
      isEdit ? (rawArgs.sourceImagePath as string | undefined) : undefined,
    ),
    source: isEdit ? (rawArgs.sourceImagePath as string | undefined) : undefined,
    // In-process runs leave modelsConsented off: the runner asks the
    // renderer's permissions layer itself.
    keepModelsLoaded: host.keepModelsLoaded,
  }

  // Cancel routes through the runner (which interrupts the engine and settles
  // this run as cancelled), so the awaited promise always settles.
  const onAbort = () => cancelArtifactRun(payload.runId)
  if (signal?.aborted) {
    onAbort()
    return toolOutput({ state: 'cancelled', items: [] })
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  let result: ArtifactRunResult
  try {
    result = await withGpuForMedia(() => submitArtifactRun(payload, { queue: 'queue' }), {
      keepModelsLoaded: host.keepModelsLoaded,
    })
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return toolOutput(result)
}

/** Builds the in-process `generateImage` / `editImage` tools for the shipped specs. */
export async function buildDirectMediaTools(
  host: CapabilityHost,
  specs: AgentToolSpec[],
): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  const { workspaceDir } = host
  return Promise.all(
    specs.map(
      (spec) =>
        pi.defineTool({
          name: spec.name,
          label: spec.name,
          description: spec.description,
          parameters: jsonSchemaParameters(spec.inputSchema),
          execute: async (_toolCallId, params, signal) => {
            const args = { ...(params as DirectArgs) }
            for (const key of spec.workspacePathInputs ?? []) {
              const value = args[key as keyof DirectArgs]
              if (typeof value === 'string' && value !== '') {
                ;(args as Record<string, unknown>)[key] = workspaceFileToDataUri(
                  workspaceDir,
                  value,
                )
              }
            }
            const result = await runDirectTool(host, spec, args, signal ?? undefined)
            return jsonResult(await saveGeneratedMediaToWorkspace(result, workspaceDir))
          },
        }) as ToolDefinition,
    ),
  )
}
