import { randomUUID } from 'node:crypto'
import { submitArtifactRun, cancelArtifactRun } from '../kernel/orchestrator.ts'
import type { ArtifactRunResult } from './runner.ts'
import { resolveComfyEntry, type PresetCatalog } from './catalog.ts'
import type { ComfyInput, ComfyUiPreset, Preset } from '@/lib/presetSchemas'
import { OPTIONAL_MODEL_NONE } from '@/lib/comfyWorkflow'
import { FALLBACK_PARAMS, presetDefault, presetDefaultResolution } from '@/lib/comfyParamDefaults'
import { isDeviceInput, isPromptSelectableInput } from '@/lib/comfyPromptInputs'
import {
  DEFAULT_RESOLUTION_CONFIG,
  findClosestResolutionInConfig,
  getResolutionForConfig,
  getResolutionsFromConfig,
} from '@/lib/comfyResolutions'
import type { ResolutionConfig, MegapixelOption } from '@/lib/presetSchemas'
import type { ArtifactRunOwner } from '@/types/kernelEvents'

// Shared in-process Comfy execution (architecture-target §8 step 12):
// generateImage / editImage, Chat parent comfyUI / comfyUiImageEdit, and the
// NL media specialist's inner Comfy tools all resolve a workflow from main's
// catalog and submit through the orchestrator. Download consent stays artifact:request.

type CatalogProvider = () => Promise<PresetCatalog>
let catalogProvider: CatalogProvider | null = null

export function setMediaCatalogProvider(provider: CatalogProvider): void {
  catalogProvider = provider
}

export function resetMediaCatalogProviderForTest(): void {
  catalogProvider = null
}

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

type ResolvedSize = {
  width?: number
  height?: number
  /** Label of the size request no supported resolution matched exactly. */
  snapped?: string
}

function resolveSize(
  preset: ComfyUiPreset,
  args: { aspectRatio?: unknown; megapixels?: unknown; resolution?: unknown },
): ResolvedSize {
  const config = preset.resolutionConfig ?? DEFAULT_RESOLUTION_CONFIG
  const aspectRatio = typeof args.aspectRatio === 'string' ? args.aspectRatio : undefined
  const megapixels = typeof args.megapixels === 'string' ? args.megapixels : undefined
  const resolution = typeof args.resolution === 'string' ? args.resolution : undefined

  if (aspectRatio || megapixels) {
    const ar = aspectRatio ?? '1/1'
    const mp = megapixels ?? getDefaultMegapixelLabel(config)
    const exact = getResolutionForConfig(config, mp, ar)
    if (exact) return { width: exact.width, height: exact.height }
    // The request leaves the preset's size vocabulary — remember what was
    // asked for so the caller can tell the model (and the user) about it.
    const snapped =
      megapixels && aspectRatio
        ? `${mp} megapixels at ${ar}`
        : megapixels
          ? `${mp} megapixels`
          : `aspect ratio ${ar}`
    const matchingAR = getResolutionsFromConfig(config).filter((r) => r.aspectRatio === ar)
    if (matchingAR.length === 0) return { snapped }
    const target = parseFloat(mp)
    const closest = matchingAR.reduce((prev, curr) =>
      Math.abs(parseFloat(curr.megapixels) - target) <
      Math.abs(parseFloat(prev.megapixels) - target)
        ? curr
        : prev,
    )
    return { width: closest.width, height: closest.height, snapped }
  }
  if (resolution) {
    const [w, h] = resolution.split('x').map(Number)
    if (w && h) {
      const match = findClosestResolutionInConfig(config, w, h)
      if (!match || (match.width === w && match.height === h)) return { width: w, height: h }
      return { width: match.width, height: match.height, snapped: `${w}x${h}` }
    }
  }
  return {}
}

type ResolvedComfyInput = ComfyInput & { current: unknown }

/**
 * A value the prompt picked for one workflow input, normalized to the input's
 * vocabulary — or `undefined` when no valid value can be derived. `adjusted`
 * names the value actually used when a numeric request left the allowed range.
 */
function normalizeDynamicInputValue(
  input: ComfyInput,
  value: unknown,
): { value: string | number | boolean; adjusted?: string } | undefined {
  if (input.options && input.options.length > 0) {
    const wanted = String(value).trim().toLowerCase()
    const match = input.options.find((option) => String(option).trim().toLowerCase() === wanted)
    return match === undefined ? undefined : { value: match }
  }
  if (input.type === 'number') {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
          ? Number(value)
          : NaN
    if (!Number.isFinite(parsed)) return undefined
    const clamped = Math.min(Math.max(parsed, input.min ?? -Infinity), input.max ?? Infinity)
    return { value: clamped, ...(clamped !== parsed ? { adjusted: String(clamped) } : {}) }
  }
  if (input.type === 'boolean') {
    if (typeof value === 'boolean') return { value }
    const lower = typeof value === 'string' ? value.trim().toLowerCase() : ''
    if (lower === 'true') return { value: true }
    if (lower === 'false') return { value: false }
    return undefined
  }
  // string / model / stringList inputs take free-form text.
  if (typeof value === 'string') return { value }
  if (typeof value === 'number' || typeof value === 'boolean') return { value: String(value) }
  return undefined
}

/**
 * Merges the prompt's label-keyed `dynamicInputs` into the resolved inputs and
 * reports everything that was refused, so the model can tell the user instead
 * of assuming the request took effect.
 */
function applyDynamicInputOverrides(
  inputs: ResolvedComfyInput[],
  dynamicInputs: unknown,
): string[] {
  if (dynamicInputs === null || typeof dynamicInputs !== 'object' || Array.isArray(dynamicInputs)) {
    return []
  }
  const notices: string[] = []
  for (const [rawLabel, value] of Object.entries(dynamicInputs as Record<string, unknown>)) {
    const label = rawLabel.trim()
    if (label === '') continue
    const input = inputs.find((i) => i.label.trim().toLowerCase() === label.toLowerCase())
    if (!input) {
      notices.push(`"${label}" is not an input of this workflow`)
      continue
    }
    if (!isPromptSelectableInput(input)) {
      notices.push(
        isDeviceInput(input)
          ? `"${input.label}" is the inference device, which the prompt cannot choose`
          : `"${input.label}" cannot be set via the prompt`,
      )
      continue
    }
    const normalized = normalizeDynamicInputValue(input, value)
    if (!normalized) {
      const allowed =
        input.options && input.options.length > 0
          ? `; allowed values: ${input.options.join(', ')}`
          : ''
      notices.push(
        `"${label}" was ignored because the requested value is not valid for it${allowed}`,
      )
      continue
    }
    input.current = normalized.value
    if (normalized.adjusted !== undefined) {
      notices.push(`"${label}" was adjusted to ${normalized.adjusted} to fit its allowed range`)
    }
  }
  return notices
}

function resolveInputs(
  preset: ComfyUiPreset,
  source?: string,
  dynamicInputs?: unknown,
): { inputs: ResolvedComfyInput[]; notices: string[] } {
  const inputs = preset.settings
    .filter((s): s is ComfyInput => 'nodeTitle' in s && 'nodeInput' in s)
    .map((input) => {
      const raw = input.defaultValue
      const current =
        input.type === 'model' &&
        input.optional === true &&
        (raw === undefined || raw === '' || raw === OPTIONAL_MODEL_NONE)
          ? OPTIONAL_MODEL_NONE
          : raw
      return { ...input, current }
    })
  const notices = applyDynamicInputOverrides(inputs, dynamicInputs)
  if (source) {
    const imageInput = inputs.find(
      (input) =>
        (input.type === 'image' ||
          input.type === 'inpaintMask' ||
          input.type === 'outpaintCanvas') &&
        input.displayed !== false &&
        input.modifiable !== false &&
        (input.current === '' || input.current === undefined),
    )
    if (imageInput) imageInput.current = source
  }
  return { inputs, notices }
}

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
  const unfinished = (result.unfinished ?? []).map((item) => ({
    id: item.id,
    type: 'image',
    state: item.state,
    imageUrl: '',
    mode: item.mode,
    settings: item.settings || {},
  }))
  if (result.state === 'cancelled') {
    return {
      success: false,
      state: 'cancelled',
      message: 'Generation cancelled.',
      images,
      ...(unfinished.length ? { unfinished } : {}),
    }
  }
  if (result.state === 'failed') {
    return {
      success: false,
      state: 'failed',
      message: `ComfyUI generation failed: ${result.error ?? 'unknown error'}`,
      ...(result.error ? { error: result.error } : {}),
      images,
      ...(unfinished.length ? { unfinished } : {}),
    }
  }
  return { images }
}

export type InProcessComfyArgs = {
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
  /** Label-keyed overrides of the workflow's ComfyUI inputs, validated against the preset. */
  dynamicInputs?: unknown
  defaultWorkflow?: string
}

export type InProcessComfyRequest = {
  kind: 'create' | 'edit'
  /** The tool the model called, named in the declined-download answer. */
  toolName?: string
  /** Workflows whose model download the user declined; one tool build keeps them for its session. */
  declinedWorkflows?: Set<string>
  /** The workflows the turn's settings enable; absent means any in the catalog. */
  allowedWorkflows?: readonly string[]
  args: InProcessComfyArgs
  source?: string
  origin: 'renderer' | 'agent'
  owner?: ArtifactRunOwner
  conversationKey?: string
  keepModelsLoaded: boolean
  signal?: AbortSignal
}

export async function runInProcessComfyTool(
  request: InProcessComfyRequest,
): Promise<Record<string, unknown>> {
  if (!catalogProvider) {
    return { success: false, message: 'No preset catalog is available in main.', images: [] }
  }
  const workflowName =
    typeof request.args.workflow === 'string' && request.args.workflow !== ''
      ? request.args.workflow
      : request.args.defaultWorkflow
  if (!workflowName) {
    return {
      success: false,
      message: 'No workflow requested and none configured as default.',
      images: [],
    }
  }

  if (request.allowedWorkflows && !request.allowedWorkflows.includes(workflowName)) {
    return {
      success: false,
      message:
        `Workflow '${workflowName}' is not enabled for this agent. ` +
        `Enabled: ${request.allowedWorkflows.join(', ') || 'none'}`,
      images: [],
    }
  }

  const declined = declinedOutput(workflowName, request.toolName)
  if (request.declinedWorkflows?.has(workflowName)) return declined

  const catalog = await catalogProvider()
  const base = catalog.comfy.get(workflowName)
  if (!base) {
    return { success: false, message: `Workflow "${workflowName}" is not available.`, images: [] }
  }
  const variant = resolveVariant(base, request.args.variant)
  const preset = resolveComfyEntry(catalog, workflowName, variant)
  if (!preset) {
    return {
      success: false,
      message: `Workflow "${workflowName}" could not be resolved.`,
      images: [],
    }
  }

  const isEdit = request.kind === 'edit'
  // Size resolution runs for edits too: a size passed by the model reaches
  // workflows that have width/height settings and is a no-op on the rest.
  const size = resolveSize(preset, request.args)
  const { width, height } = size
  const prompt =
    typeof request.args.prompt === 'string'
      ? request.args.prompt
      : ((presetDefault(preset, 'prompt') as string | undefined) ?? '')
  const [defaultWidth, defaultHeight] = presetDefaultResolution(preset)
  const mediaType = preset.mediaType ?? 'image'
  // Same chain as the panel path (runArtifact.resolveParams): model-passed
  // value → preset-declared default → last-resort fallback, so an agent run of
  // a preset runs with the settings the preset itself declares.
  const requestedBatch =
    (typeof request.args.batchSize === 'number' ? request.args.batchSize : undefined) ??
    (presetDefault(preset, 'batchSize') as number | undefined)

  const { inputs, notices } = resolveInputs(
    preset,
    isEdit ? request.source : undefined,
    request.args.dynamicInputs,
  )

  const payload = {
    runId: randomUUID(),
    mode: (isEdit ? 'imageEdit' : 'imageGen') as 'imageEdit' | 'imageGen',
    preset,
    params: {
      prompt,
      negativePrompt:
        typeof request.args.negativePrompt === 'string'
          ? request.args.negativePrompt
          : ((presetDefault(preset, 'negativePrompt') as string | undefined) ??
            FALLBACK_PARAMS.negativePrompt),
      seed:
        typeof request.args.seed === 'number'
          ? request.args.seed
          : ((presetDefault(preset, 'seed') as number | undefined) ?? FALLBACK_PARAMS.seed),
      inferenceSteps:
        typeof request.args.inferenceSteps === 'number'
          ? request.args.inferenceSteps
          : ((presetDefault(preset, 'inferenceSteps') as number | undefined) ??
            FALLBACK_PARAMS.inferenceSteps),
      width: width ?? defaultWidth ?? FALLBACK_PARAMS.width,
      height: height ?? defaultHeight ?? FALLBACK_PARAMS.height,
      // Batching only makes sense for image creates; video and 3D are
      // expensive and a single result is expected, so batch is forced to 1.
      batchSize:
        isEdit || mediaType !== 'image' ? 1 : Number(requestedBatch ?? FALLBACK_PARAMS.batchSize),
    },
    inputs,
    source: isEdit ? request.source : undefined,
    keepModelsLoaded: request.keepModelsLoaded,
    variant,
    origin: request.origin,
    owner: request.owner,
    conversationKey: request.conversationKey,
  }

  const onAbort = () => cancelArtifactRun(payload.runId)
  if (request.signal?.aborted) {
    onAbort()
    return toolOutput({ state: 'cancelled', items: [] })
  }
  request.signal?.addEventListener('abort', onAbort, { once: true })
  let result: ArtifactRunResult
  try {
    result = await submitArtifactRun(payload, { queue: 'queue' })
  } finally {
    request.signal?.removeEventListener('abort', onAbort)
  }
  if (result.declined) {
    request.declinedWorkflows?.add(workflowName)
    return declined
  }
  const output = toolOutput(result)
  if (result.state === 'completed') {
    // The runner stamps the size the workflow actually produced on each item;
    // the requested params only stand in when it could not.
    const first = result.items[0]
    const usedSize =
      (typeof first?.settings?.resolution === 'string' ? first.settings.resolution : undefined) ??
      `${payload.params.width}x${payload.params.height}`
    output.size = usedSize
    // The requested size left the preset's supported vocabulary: say what was
    // actually used so the model tells the user instead of a silent swap.
    if (size.snapped) {
      output.sizeNotice = `Requested ${size.snapped}, but the "${workflowName}" workflow supports a fixed set of sizes and used ${usedSize}. Tell the user which size was actually used.`
    }
    // Same honesty for refused workflow-input requests: the model must not
    // report settings as applied that the run dropped.
    if (notices.length > 0) {
      output.inputsNotice =
        'Some requested workflow inputs were not applied: ' +
        `${notices.join('; ')}. Tell the user which of their requested settings did not take effect.`
    }
  }
  return output
}

function declinedOutput(workflowName: string, toolName = 'this tool'): Record<string, unknown> {
  return {
    success: false,
    state: 'cancelled',
    declined: true,
    message:
      `The user declined the download of the models for the "${workflowName}" workflow, so it is ` +
      `unavailable. Do not call ${toolName} with this workflow again; continue without it or ` +
      'tell the user.',
    images: [],
  }
}
