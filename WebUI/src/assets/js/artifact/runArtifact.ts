import { ref, watch } from 'vue'
import {
  useComfyUiPresets,
  type ComfyGenerationInput,
  type ComfyGenerationParams,
  type ComfyGenerationRun,
} from '../store/comfyUiPresets'
import {
  OPTIONAL_MODEL_NONE,
  presetSettingsKey,
  useImageGenerationPresets,
  type GenerationSettings,
  type MediaItem,
} from '../store/imageGenerationPresets'
import { usePresets, type ComfyInput, type ComfyUiPreset, type Preset } from '../store/presets'
import { imageUrlToDataUri } from '@/lib/utils'
import { isCancellation } from '../errors/appError'
import { presetToMode } from '@/lib/presetModes'

/**
 * Renderer-side Artifact capability: one fully-resolved request in, one settled
 * result out. Callers (the Image Gen UI, the chat media tools, Home Agent
 * channels) never touch selection state to make a run happen — no preset
 * switch, no variant activation, no prompt-field mutation. Everything that
 * decides the output travels on the request; everything the run produces is
 * carried by the tracked MediaItems it registers.
 */

export type ArtifactKind = 'create-image' | 'edit-image' | 'create-video' | 'create-3d'

export type ArtifactRequest = {
  kind: ArtifactKind
  /** Preset (workflow) name, as offered by the tool catalog / preset list. */
  workflow: string
  /** Explicit variant name; invalid names fall back like the UI does. */
  variant?: string
  prompt?: string
  negativePrompt?: string
  /** Source image (data URI, aipg-media:// or file URL) for edit-style kinds. */
  source?: string
  /**
   * Which media bucket the items land in (history, output schema). Defaults to
   * the preset's category-derived mode. Tools pin this because their output
   * schema is mode-tagged.
   */
  mode?: WorkflowModeType
  params?: {
    seed?: number
    width?: number
    height?: number
    inferenceSteps?: number
    batchSize?: number
  }
}

export type ArtifactRunContext = {
  /** Chat/tool activity the generation FSM phases nest under. */
  parentActivityId?: string | null
  abortSignal?: AbortSignal
}

export type ArtifactResult = {
  state: 'completed' | 'failed' | 'cancelled'
  /** Items that reached 'done' — the full batch on success, partials otherwise. */
  items: MediaItem[]
  error?: string
}

/**
 * Idle watchdog window, matching the tool watchers this module replaces: the
 * timer re-arms on every progress signal (tracked item, FSM state, step text)
 * so long-but-healthy renders run to completion and only a true stall fires.
 */
const GENERATION_IDLE_TIMEOUT_MS = 5 * 60_000

// Fallbacks when neither the request nor the preset declares a value. Matches
// the create tool's historic defaults; presets normally declare their own.
const FALLBACK_PARAMS: Omit<ComfyGenerationParams, 'prompt'> = {
  seed: -1,
  width: 512,
  height: 512,
  inferenceSteps: 6,
  batchSize: 1,
  negativePrompt: 'nsfw',
}

const QUEUED_PLACEHOLDER_URL =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"%3E%3C/svg%3E'

function presetDefault(preset: Preset, settingName: string): unknown {
  return preset.settings.find(
    (s) => 'settingName' in s && s.settingName === settingName,
  )?.defaultValue
}

function settingIsRelevantFor(preset: Preset, settingName: string): boolean {
  const setting = preset.settings.find(
    (s) => 'settingName' in s && s.settingName === settingName,
  )
  return setting ? setting.displayed || setting.modifiable : false
}

/**
 * Variant semantics per surface: an explicit (and valid) request variant wins;
 * otherwise the user's remembered variant for that workflow; otherwise the
 * first variant — mirroring what a preset switch would resolve to, without
 * the switch. Drivers that prefer a "Fast" variant (the chat tools) resolve it
 * themselves and pass it explicitly.
 */
function resolveVariantName(preset: Preset, requested: string | undefined): string | undefined {
  if (requested && preset.variants?.some((v) => v.name === requested)) return requested
  if (preset.variants && preset.variants.length > 0) {
    return preset.variants[0].name
  }
  return undefined
}

function resolveParams(
  request: ArtifactRequest,
  preset: ComfyUiPreset,
): ComfyGenerationParams {
  const params = request.params ?? {}
  const mediaType = preset.mediaType ?? 'image'
  const resolutionDefault = presetDefault(preset, 'resolution')
  const [defaultWidth, defaultHeight] =
    typeof resolutionDefault === 'string'
      ? resolutionDefault.split('x').map(Number)
      : [undefined, undefined]

  // Batching only makes sense for images (cheap alternates); video and 3D are
  // expensive and a single result is expected, so batch is forced to 1.
  const requestedBatch = params.batchSize ?? presetDefault(preset, 'batchSize')

  return {
    prompt: request.prompt ?? (presetDefault(preset, 'prompt') as string | undefined) ?? '',
    negativePrompt:
      request.negativePrompt ??
      (presetDefault(preset, 'negativePrompt') as string | undefined) ??
      FALLBACK_PARAMS.negativePrompt,
    seed: params.seed ?? (presetDefault(preset, 'seed') as number | undefined) ??
      FALLBACK_PARAMS.seed,
    inferenceSteps:
      params.inferenceSteps ??
      (presetDefault(preset, 'inferenceSteps') as number | undefined) ??
      FALLBACK_PARAMS.inferenceSteps,
    width: params.width ?? defaultWidth ?? FALLBACK_PARAMS.width,
    height: params.height ?? defaultHeight ?? FALLBACK_PARAMS.height,
    batchSize: mediaType === 'image' ? Number(requestedBatch ?? FALLBACK_PARAMS.batchSize) : 1,
  }
}

/**
 * Snapshot of the workflow's dynamic inputs with their resolved current
 * values, read from the same per-persisted-preset map the settings sidebar
 * writes into. Plain refs: the run owns them, so injecting a source image (or
 * any other change) can't leak back into the persisted settings.
 */
function resolveInputs(
  preset: ComfyUiPreset,
  variantName: string | undefined,
  savedInputs: Record<string, unknown> | undefined,
): ComfyGenerationInput[] {
  const inputSettings = preset.settings.filter(
    (s): s is ComfyInput => 'nodeTitle' in s && 'nodeInput' in s,
  )
  return inputSettings.map((input) => {
    const raw =
      savedInputs?.[`${input.nodeTitle}.${input.nodeInput}`] ?? input.defaultValue
    const initial =
      input.type === 'model' &&
      input.optional === true &&
      (raw === undefined || raw === '' || raw === OPTIONAL_MODEL_NONE)
        ? OPTIONAL_MODEL_NONE
        : raw
    return { ...input, current: ref(initial) }
  })
}

function buildSettings(
  preset: ComfyUiPreset,
  variantName: string | undefined,
  params: ComfyGenerationParams,
  safetyCheck: boolean,
  showPreview: boolean,
): GenerationSettings {
  const allSettings = {
    preset: preset.name,
    variant: variantName,
    device: 0, // TODO get correct device from backend service
    prompt: params.prompt,
    negativePrompt: params.negativePrompt,
    batchSize: params.batchSize,
    inferenceSteps: params.inferenceSteps,
    seed: params.seed,
    height: params.height,
    width: params.width,
    resolution: `${params.width}x${params.height}`,
    safetyCheck,
    showPreview,
  }
  return Object.fromEntries(
    Object.entries(allSettings).filter(
      ([key]) =>
        key === 'preset' || key === 'variant' || key === 'device' || settingIsRelevantFor(preset, key),
    ),
  )
}

function isDoneWithMedia(item: MediaItem): boolean {
  return (
    item.state === 'done' &&
    ((item.type === 'image' && !!item.imageUrl) ||
      (item.type === 'video' && !!item.videoUrl) ||
      (item.type === 'model3d' && !!item.model3dUrl))
  )
}

/**
 * Resolve and run one media generation. Resolves when every tracked item has
 * settled (done / failed / stopped), the FSM errored, the caller aborted, or
 * the idle watchdog fired. A user cancelling the required-model download
 * still throws (`isCancellation`) so the UI's pre-existing catch — which
 * resets the prompt bar — keeps working.
 */
export async function runArtifact(
  request: ArtifactRequest,
  ctx: ArtifactRunContext = {},
): Promise<ArtifactResult> {
  const presetsStore = usePresets()
  const imageGen = useImageGenerationPresets()
  const comfyUi = useComfyUiPresets()

  const failed = (error: string): ArtifactResult => ({ state: 'failed', items: [], error })

  // 1. Resolve the workflow + variant without touching selection state.
  const basePreset = presetsStore.presets.find(
    (p) => p.name === request.workflow && p.type === 'comfy' && p.backend === 'comfyui',
  )
  if (!basePreset) return failed(`Unknown workflow "${request.workflow}"`)

  const requestedVariant = request.variant ?? presetsStore.activeVariantName[request.workflow]
  const variantName = resolveVariantName(basePreset, requestedVariant)
  const preset = (variantName
    ? presetsStore.resolvePresetVariant(request.workflow, variantName)
    : basePreset) as ComfyUiPreset | null
  if (!preset) return failed(`Unknown workflow "${request.workflow}"`)

  const mode: WorkflowModeType = request.mode ?? (presetToMode(preset) as WorkflowModeType)
  const params = resolveParams(request, preset)
  const settingsKey = presetSettingsKey(preset.name, variantName)
  const inputs = resolveInputs(preset, variantName, imageGen.comfyInputsPerPreset[settingsKey])

  // 2. Edit kinds: inject the source image into the first required image
  // input, matching what the settings sidebar's LoadImage field would hold.
  if (request.source) {
    const imageInput = inputs.find(
      (input) =>
        (input.type === 'image' ||
          input.type === 'inpaintMask' ||
          input.type === 'outpaintCanvas') &&
        input.displayed !== false &&
        input.modifiable !== false &&
        (input.defaultValue === '' || input.defaultValue === undefined),
    )
    if (!imageInput) return failed('No suitable image input found in the preset')
    try {
      imageInput.current.value = await imageUrlToDataUri(request.source)
    } catch (error) {
      return failed(
        `Failed to convert source image: ${error instanceof Error ? error.message : 'Unknown error'}`,
      )
    }
  }

  // Cancelled before anything was queued — don't pull in models nobody waits for.
  if (ctx.abortSignal?.aborted) return { state: 'cancelled', items: [] }

  // 3. Required models. Download approval routes through the dialog (or the
  // remote channel on Home Agent turns) exactly as the UI path always did.
  try {
    await imageGen.ensureModelsAreAvailableFor(preset)
  } catch (error) {
    if (isCancellation(error)) throw error
    return failed(
      `Required models are unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`,
    )
  }

  // 4. Create the tracked items — the run's only footprint on shared state.
  const baseSeed =
    params.seed === -1 ? Math.floor(Math.random() * 1_000_000) : params.seed
  const baseSettings = buildSettings(
    preset,
    variantName,
    params,
    imageGen.safetyCheck,
    imageGen.showPreview,
  )
  const items: MediaItem[] = Array.from({ length: params.batchSize }, (_, i) => ({
    id: crypto.randomUUID(),
    mode,
    sourceImageUrl: request.source,
    state: 'queued' as const,
    type: 'image' as const,
    imageUrl: QUEUED_PLACEHOLDER_URL,
    settings: { ...baseSettings, seed: baseSeed + i },
    dynamicSettings: inputs.map((input) => ({
      ...input,
      current: input.current.value as never,
    })),
  }))
  items.forEach((item) => imageGen.updateImage(item))
  imageGen.lastError = null
  imageGen.generationParentActivityId = ctx.parentActivityId ?? null

  const removeQueuedStubs = () => {
    const trackedIds = new Set(items.map((item) => item.id))
    imageGen.generatedImages = imageGen.generatedImages.filter(
      (img) => !trackedIds.has(img.id),
    )
  }

  // 5. Submit. Refused runs (a generation already in flight) fail fast
  // instead of watching items that will never move.
  const run: ComfyGenerationRun = { preset, items, params, inputs, sourceImage: request.source }
  const accepted = await comfyUi.generate(run)
  if (!accepted) {
    const errored = items.some(
      (item) => imageGen.generatedImages.find((img) => img.id === item.id)?.state === 'failed',
    )
    removeQueuedStubs()
    return errored
      ? failed(imageGen.lastError ?? 'Generation failed')
      : failed('Another generation is already in progress')
  }

  // 6. Wait for the FSM/websocket to settle the items.
  const trackedIds = new Set(items.map((item) => item.id))
  const trackedItems = () => imageGen.generatedImages.filter((img) => trackedIds.has(img.id))
  const doneItems = () => trackedItems().filter(isDoneWithMedia)

  return await new Promise<ArtifactResult>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    let stopWatcher: (() => void) | null = null
    let stopListeningForAbort: (() => void) | null = null

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      if (stopWatcher) {
        stopWatcher()
        stopWatcher = null
      }
      if (stopListeningForAbort) {
        stopListeningForAbort()
        stopListeningForAbort = null
      }
    }

    // Aborting has to reach ComfyUI: it has the prompt already and would
    // happily load a 30 GB model and render it while nobody waits. `stop()`
    // clears the queue, interrupts the run and settles the tracked items.
    const onAbort = () => {
      cleanup()
      void comfyUi.stop()
      resolve({ state: 'cancelled', items: doneItems(), error: 'Generation cancelled.' })
    }
    if (ctx.abortSignal) {
      if (ctx.abortSignal.aborted) {
        onAbort()
        return
      }
      ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
      stopListeningForAbort = () => ctx.abortSignal?.removeEventListener('abort', onAbort)
    }

    const armIdleTimeout = () => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => {
        cleanup()
        void comfyUi.stop()
        resolve({
          state: 'failed',
          items: doneItems(),
          error: 'Generation stalled (no progress for 5 minutes)',
        })
      }, GENERATION_IDLE_TIMEOUT_MS)
    }

    const check = () => {
      const tracked = trackedItems()
      // Don't keep waiting for a 'done' that will never arrive — this was the
      // source of multi-minute tool-call stalls in the old per-tool watchers.
      if (
        imageGen.currentState === 'error' ||
        tracked.some((item) => item.state === 'failed')
      ) {
        cleanup()
        resolve({
          state: 'failed',
          items: doneItems(),
          error: imageGen.lastError ?? 'Generation failed',
        })
        return
      }
      if (tracked.some((item) => item.state === 'stopped')) {
        cleanup()
        resolve({ state: 'cancelled', items: doneItems(), error: 'Generation cancelled.' })
        return
      }
      const completed = tracked.filter(isDoneWithMedia)
      if (completed.length >= params.batchSize) {
        cleanup()
        resolve({ state: 'completed', items: completed })
      }
    }

    armIdleTimeout()
    // Watch the items, FSM state and step text: failures surface immediately
    // and every progress tick re-arms the idle watchdog.
    stopWatcher = watch(
      () => [imageGen.generatedImages, imageGen.currentState, imageGen.stepText],
      () => {
        armIdleTimeout()
        check()
      },
      { deep: true },
    )
    check()
  })
}
