import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { MediaItem } from '@/assets/js/store/imageGenerationPresets'
import type { ComfyInput, Preset, Setting } from '@/assets/js/store/presets'

// The artifact runner is tested against hand-driven store mocks: only its own
// contract matters here — request → resolved run (params, variant, inputs,
// items), and the terminal-state watcher. The engine store (comfyUiPresets)
// is stubbed at its generate()/stop() seam.

const generatedImages = ref<MediaItem[]>([])
const comfyInputsPerPreset = ref<Record<string, Record<string, unknown>>>({})
const lastError = ref<string | null>(null)
const parentActivityId = ref<string | null>(null)
const presetsFixture = ref<Preset[]>([])
const activeVariantName = ref<Record<string, string>>({})
const currentState = ref<string>('no_start')
const stepText = ref('')

const generateMock = vi.fn<(run: unknown, isRetry?: boolean) => Promise<boolean>>()
const stopMock = vi.fn<() => Promise<void>>()
const ensureModelsMock = vi.fn<(preset: unknown) => Promise<void>>()
const failGenerationMock = vi.fn<(message: string) => void>()
const resolvePresetVariantMock = vi.fn<(name: string, variant?: string | null) => Preset | null>()
const imageUrlToDataUriMock = vi.fn<(source: string) => Promise<string>>()

// Mirrors the real pure helper the runner imports (the module itself is mocked
// below because its store half drags the whole renderer graph with it).
vi.mock('@/assets/js/store/imageGenerationPresets', () => ({
  OPTIONAL_MODEL_NONE: 'None',
  presetSettingsKey: (presetName: string, variant?: string | null) =>
    variant ? `${presetName}:${variant}` : presetName,
  useImageGenerationPresets: () => ({
    get generatedImages() {
      return generatedImages.value
    },
    set generatedImages(value: MediaItem[]) {
      generatedImages.value = value
    },
    get comfyInputsPerPreset() {
      return comfyInputsPerPreset.value
    },
    get currentState() {
      return currentState.value
    },
    get stepText() {
      return stepText.value
    },
    get lastError() {
      return lastError.value
    },
    set lastError(value: string | null) {
      lastError.value = value
    },
    get generationParentActivityId() {
      return parentActivityId.value
    },
    set generationParentActivityId(value: string | null) {
      parentActivityId.value = value
    },
    get safetyCheck() {
      return true
    },
    get showPreview() {
      return false
    },
    updateImage: (item: MediaItem) => {
      const list = generatedImages.value
      const idx = list.findIndex((img) => img.id === item.id)
      if (idx === -1) {
        generatedImages.value = [...list, item]
      } else {
        const copy = [...list]
        copy[idx] = item
        generatedImages.value = copy
      }
    },
    failGeneration: failGenerationMock,
    ensureModelsAreAvailableFor: ensureModelsMock,
  }),
}))

vi.mock('@/assets/js/store/comfyUiPresets', () => ({
  useComfyUiPresets: () => ({
    generate: generateMock,
    stop: stopMock,
  }),
}))

vi.mock('@/assets/js/store/presets', () => ({
  // Real value — the (unmocked) presetModes module imports this constant.
  AUDIO_CATEGORY: 'audio',
  usePresets: () => ({
    get presets() {
      return presetsFixture.value
    },
    get activeVariantName() {
      return activeVariantName.value
    },
    getFirstVariantName: (preset: Preset) => preset.variants?.[0]?.name ?? null,
    resolvePresetVariant: resolvePresetVariantMock,
  }),
}))

vi.mock('@/lib/utils', () => ({
  imageUrlToDataUri: imageUrlToDataUriMock,
}))

const { runArtifact, artifactKindForMedia } = await import('@/assets/js/artifact/runArtifact')
const { createAppError } = await import('@/assets/js/errors/appError')

type ComfyFixture = Preset & {
  type: 'comfy'
  backend: 'comfyui'
}

function comfyPreset(overrides: Partial<ComfyFixture> & { name: string }): ComfyFixture {
  return {
    type: 'comfy',
    backend: 'comfyui',
    category: 'create-images',
    settings: [],
    description: '',
    ...overrides,
  } as unknown as ComfyFixture
}

/** Wire the presets-store mock the way the real store resolves variants. */
function applyVariantForReal(name: string, variant?: string | null): Preset | null {
  const preset = presetsFixture.value.find((p) => p.name === name)
  if (!preset) return null
  if (!variant || !preset.variants?.some((v) => v.name === variant)) return preset
  const overrides = preset.variants.find((v) => v.name === variant)?.overrides
  // Mirrors the real applyVariant: deep merge of the variant's overrides into
  // the base preset — the preset's own name stays untouched.
  return { ...preset, ...overrides }
}

function standardSetting(settingName: string, defaultValue: unknown): Setting {
  return {
    type: 'number',
    label: settingName,
    displayed: true,
    modifiable: true,
    settingName,
    defaultValue,
  } as unknown as Setting
}

function imageInputFixture(): ComfyInput {
  return {
    type: 'image',
    label: 'Source',
    nodeTitle: 'LoadImage',
    nodeInput: 'image',
    displayed: true,
    modifiable: true,
    defaultValue: '',
  } as unknown as ComfyInput
}

/**
 * Start a run and wait until it has submitted to the (mocked) engine. The
 * pending promise rides in a box: an async function returning it directly
 * would adopt it, so `await startAndAwaitSubmit(...)` would wait for the
 * generation itself — which only the caller's next line can settle.
 */
async function startAndAwaitSubmit(request: Parameters<typeof runArtifact>[0]) {
  const pending = runArtifact(request)
  await vi.waitFor(() => expect(generateMock).toHaveBeenCalled())
  return { result: pending }
}

function settleDone() {
  generatedImages.value = generatedImages.value.map((img) => ({
    ...img,
    type: 'image',
    state: 'done',
    imageUrl: `aipg-media://${img.id}.png`,
  })) as MediaItem[]
}

describe('runArtifact', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    generatedImages.value = []
    comfyInputsPerPreset.value = {}
    lastError.value = null
    parentActivityId.value = null
    currentState.value = 'no_start'
    stepText.value = ''
    activeVariantName.value = {}
    generateMock.mockReset().mockResolvedValue(true)
    stopMock.mockReset().mockResolvedValue()
    ensureModelsMock.mockReset().mockResolvedValue()
    failGenerationMock.mockReset().mockImplementation((message: string) => {
      // Mirrors the real store: the failed panel reads this.
      lastError.value = message
      generatedImages.value = generatedImages.value.map((img) =>
        img.state === 'queued' || img.state === 'generating'
          ? ({ ...img, state: 'failed' as const } as MediaItem)
          : img,
      )
    })
    imageUrlToDataUriMock.mockReset().mockImplementation(async (source: string) => source)
    resolvePresetVariantMock.mockReset().mockImplementation(applyVariantForReal)
  })

  it('falls back to the global constants when the request and preset are silent', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    settleDone()
    expect((await result).state).toBe('completed')

    const run = generateMock.mock.calls[0][0] as {
      params: Record<string, unknown>
      preset: Preset
    }
    expect(run.params).toMatchObject({
      prompt: 'a castle',
      negativePrompt: 'nsfw',
      seed: -1,
      inferenceSteps: 6,
      width: 512,
      height: 512,
      batchSize: 1,
    })
  })

  it('prefers request values over preset defaults over the fallback constants', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Draft Image',
        settings: [
          standardSetting('inferenceSteps', 30),
          standardSetting('negativePrompt', 'blurry'),
          standardSetting('seed', 7),
          standardSetting('resolution', '1024x768'),
          standardSetting('batchSize', 4),
        ],
      }),
    ]

    const pending = runArtifact({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
      negativePrompt: 'custom',
      params: { seed: 42, inferenceSteps: 12, batchSize: 2 },
    })
    await vi.waitFor(() => expect(generateMock).toHaveBeenCalled())
    settleDone()
    await pending

    const run = generateMock.mock.calls[0][0] as {
      params: Record<string, unknown>
      items: MediaItem[]
    }
    // Request wins for what it named; preset defaults fill the rest.
    expect(run.params).toMatchObject({
      prompt: 'a castle',
      negativePrompt: 'custom',
      seed: 42,
      inferenceSteps: 12,
      width: 1024,
      height: 768,
      batchSize: 2,
    })
    // Fixed seed + batch index → per-item seeds 42, 43.
    expect(run.items.map((item) => item.settings.seed)).toEqual([42, 43])
  })

  it('forces batchSize 1 for video workflows regardless of the request', async () => {
    presetsFixture.value = [
      comfyPreset({ name: 'LTX Video', mediaType: 'video', category: 'create-videos' }),
    ]

    const { result } = await startAndAwaitSubmit({
      kind: 'create-video',
      workflow: 'LTX Video',
      prompt: 'a wave',
      params: { batchSize: 4 },
    })
    settleDone()
    await result

    const run = generateMock.mock.calls[0][0] as { params: { batchSize: number } }
    expect(run.params.batchSize).toBe(1)
  })

  it('fails fast on an unknown workflow without touching the engine', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]

    const result = await runArtifact({
      kind: 'create-image',
      workflow: 'Nope',
      prompt: 'a castle',
    })

    expect(result).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('Unknown workflow'),
    })
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('resolves the variant like a preset switch would, without switching', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Draft Image',
        variants: [
          { name: 'Standard', overrides: { description: 'standard variant' } },
          { name: 'Fast', overrides: {} },
        ],
      }),
    ]

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      variant: 'Bogus',
      prompt: 'a castle',
    })
    settleDone()
    await result

    // Invalid requested variant falls back to the first, like getPresetWithVariant.
    expect(resolvePresetVariantMock).toHaveBeenCalledWith('Draft Image', 'Standard')
    const run = generateMock.mock.calls[0][0] as { preset: Preset }
    // The variant's overrides are merged in; the preset's own name is untouched.
    expect(run.preset.name).toBe('Draft Image')
    expect(run.preset.description).toBe('standard variant')
  })

  it('falls back to the remembered variant when the request names none', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Draft Image',
        variants: [
          { name: 'Standard', overrides: {} },
          { name: 'Fast', overrides: {} },
        ],
      }),
    ]
    activeVariantName.value = { 'Draft Image': 'Fast' }

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    settleDone()
    await result

    expect(resolvePresetVariantMock).toHaveBeenCalledWith('Draft Image', 'Fast')
  })

  it('snapshots saved dynamic inputs and bypasses missing optional model inputs', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Draft Image',
        variants: [{ name: 'Fast', overrides: {} }],
        settings: [
          {
            type: 'model',
            label: 'LoRA',
            nodeTitle: 'LoraLoader',
            nodeInput: 'lora_name',
            displayed: true,
            modifiable: true,
            modelType: 'loras',
            optional: true,
          },
          {
            type: 'model',
            label: 'Checkpoint',
            nodeTitle: 'CheckpointLoaderSimple',
            nodeInput: 'ckpt_name',
            displayed: true,
            modifiable: true,
            modelType: 'checkpoints',
            optional: true,
          },
        ],
      }),
    ]
    comfyInputsPerPreset.value = {
      // Keyed with the variant applied, like the real settings sidebar does.
      'Draft Image:Fast': { 'LoraLoader.lora_name': 'my-lora.safetensors' },
    }

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    settleDone()
    await result

    const run = generateMock.mock.calls[0][0] as {
      inputs: Array<{ nodeTitle: string; current: { value: unknown } }>
    }
    const byRef = (title: string) =>
      run.inputs.find((input) => input.nodeTitle === title)!.current.value
    expect(byRef('LoraLoader')).toBe('my-lora.safetensors')
    // Optional model input with no saved value → bypass marker.
    expect(byRef('CheckpointLoaderSimple')).toBe('None')
  })

  it('injects the source image into the first required image input', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Edit By Prompt',
        category: 'edit-images',
        settings: [imageInputFixture()],
      }),
    ]
    imageUrlToDataUriMock.mockResolvedValue('data:image/png;base64,SOURCE')

    const { result } = await startAndAwaitSubmit({
      kind: 'edit-image',
      workflow: 'Edit By Prompt',
      prompt: 'make it blue',
      source: 'aipg-media://source.png',
    })
    settleDone()
    await result

    expect(imageUrlToDataUriMock).toHaveBeenCalledWith('aipg-media://source.png')
    const run = generateMock.mock.calls[0][0] as {
      inputs: Array<{ current: { value: unknown } }>
      sourceImage: string
      items: MediaItem[]
    }
    expect(run.inputs[0].current.value).toBe('data:image/png;base64,SOURCE')
    expect(run.sourceImage).toBe('aipg-media://source.png')
    expect(run.items[0].sourceImageUrl).toBe('aipg-media://source.png')
  })

  it('fails when an edit has no suitable image input', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Edit By Prompt',
        category: 'edit-images',
        settings: [{ ...imageInputFixture(), defaultValue: 'preset-default.png' }],
      }),
    ]

    const result = await runArtifact({
      kind: 'edit-image',
      workflow: 'Edit By Prompt',
      prompt: 'make it blue',
      source: 'aipg-media://source.png',
    })

    expect(result).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('No suitable image input'),
    })
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('rethrows a cancelled model download instead of failing silently', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    ensureModelsMock.mockRejectedValue(
      createAppError({
        category: 'validation',
        code: 'user/cancelled',
        userMessage: 'Download cancelled',
      }),
    )

    await expect(
      runArtifact({ kind: 'create-image', workflow: 'Draft Image', prompt: 'a castle' }),
    ).rejects.toMatchObject({ code: 'user/cancelled' })
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('removes the queued stubs and fails fast when the engine refuses a run', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    generateMock.mockResolvedValue(false)

    const result = await runArtifact({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })

    expect(result).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('already in progress'),
    })
    expect(generatedImages.value).toEqual([])
  })

  it('resolves completed with the done items once every batch entry settles', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Draft Image',
        settings: [
          standardSetting('inferenceSteps', 30),
          { ...standardSetting('batchSize', 4), displayed: false, modifiable: false },
        ],
      }),
    ]

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
      params: { seed: 5, batchSize: 2 },
    })

    // Two queued placeholders are registered before the run is submitted.
    expect(generatedImages.value).toHaveLength(2)
    expect(parentActivityId.value).toBeNull()

    settleDone()
    const settled = await result

    expect(settled.state).toBe('completed')
    expect(settled.items).toHaveLength(2)
    expect(
      settled.items.every(
        (item) => 'imageUrl' in item && item.imageUrl.startsWith('aipg-media://'),
      ),
    ).toBe(true)
    // Settings snapshots are filtered by what the preset displays/modifies;
    // the seed rides along regardless — the engine reads it off every item.
    expect(settled.items[0].settings).toMatchObject({
      preset: 'Draft Image',
      inferenceSteps: 30,
      seed: 5,
    })
    expect(settled.items[0].settings).not.toHaveProperty('batchSize')
    expect(settled.items[0].settings).not.toHaveProperty('resolution')
  })

  it('resolves failed when an item fails, carrying the store error', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]

    const { result: pending } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    lastError.value = 'The ComfyUI backend could not generate the image.'
    generatedImages.value = generatedImages.value.map((img) => ({
      ...img,
      state: 'failed',
    })) as MediaItem[]

    const result = await pending
    expect(result).toMatchObject({
      state: 'failed',
      error: 'The ComfyUI backend could not generate the image.',
    })
  })

  it('resolves cancelled when an item is stopped', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]

    const { result: pending } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    generatedImages.value = generatedImages.value.map((img) => ({
      ...img,
      state: 'stopped',
    })) as MediaItem[]

    const result = await pending
    expect(result).toMatchObject({ state: 'cancelled' })
  })

  it('stops the engine and resolves cancelled when the caller aborts mid-run', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    const controller = new AbortController()

    const pending = runArtifact(
      { kind: 'create-image', workflow: 'Draft Image', prompt: 'a castle' },
      { abortSignal: controller.signal },
    )
    await vi.waitFor(() => expect(generateMock).toHaveBeenCalled())
    controller.abort()

    const result = await pending
    expect(result).toMatchObject({ state: 'cancelled' })
    expect(stopMock).toHaveBeenCalled()
  })

  it('resolves cancelled without registering items when the signal fires while models prepare', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    let resolveModels!: () => void
    ensureModelsMock.mockImplementation(
      () => new Promise<void>((resolve) => (resolveModels = resolve)),
    )
    const controller = new AbortController()

    const pending = runArtifact(
      { kind: 'create-image', workflow: 'Draft Image', prompt: 'a castle' },
      { abortSignal: controller.signal },
    )
    controller.abort()
    resolveModels()

    const result = await pending
    expect(result).toMatchObject({ state: 'cancelled', items: [] })
    expect(generateMock).not.toHaveBeenCalled()
    expect(generatedImages.value).toEqual([])
    expect(stopMock).not.toHaveBeenCalled()
  })

  it('stops the engine again when a submit that was aborted lands in the queue afterwards', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    let resolveGenerate!: (accepted: boolean) => void
    generateMock.mockImplementation(
      () => new Promise<boolean>((resolve) => (resolveGenerate = resolve)),
    )
    const controller = new AbortController()

    const pending = runArtifact(
      { kind: 'create-image', workflow: 'Draft Image', prompt: 'a castle' },
      { abortSignal: controller.signal },
    )
    // The placeholders are registered before submit, so the abort listener is
    // armed for this window even though the prompt has not been queued yet.
    await vi.waitFor(() => expect(generatedImages.value).toHaveLength(1))
    controller.abort()

    const result = await pending
    expect(result).toMatchObject({ state: 'cancelled' })
    expect(stopMock).toHaveBeenCalledTimes(1)

    // The engine finishes queueing only after the abort — whatever landed in
    // the queue after the pre-queue stop() must be cleared too.
    resolveGenerate(true)
    await vi.waitFor(() => expect(stopMock).toHaveBeenCalledTimes(2))
  })

  it('does not leak the injected source back into the persisted input map', async () => {
    presetsFixture.value = [
      comfyPreset({
        name: 'Edit By Prompt',
        category: 'edit-images',
        settings: [imageInputFixture()],
      }),
    ]
    comfyInputsPerPreset.value = { 'Edit By Prompt': { 'LoadImage.image': 'preset-default.png' } }
    imageUrlToDataUriMock.mockResolvedValue('data:image/png;base64,SOURCE')

    const { result } = await startAndAwaitSubmit({
      kind: 'edit-image',
      workflow: 'Edit By Prompt',
      prompt: 'make it blue',
      source: 'aipg-media://source.png',
    })
    settleDone()
    await result

    const run = generateMock.mock.calls[0][0] as {
      inputs: Array<{ current: { value: unknown } }>
    }
    expect(run.inputs[0].current.value).toBe('data:image/png;base64,SOURCE')
    expect(comfyInputsPerPreset.value['Edit By Prompt']['LoadImage.image']).toBe(
      'preset-default.png',
    )
  })

  it('owns the stall watchdog: fails the items and stops the engine after 5 idle minutes', async () => {
    vi.useFakeTimers()
    try {
      presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
      const pending = runArtifact({
        kind: 'create-image',
        workflow: 'Draft Image',
        prompt: 'a castle',
      })
      // Flush the submit microtask chain without ticking the clock.
      await vi.advanceTimersByTimeAsync(0)
      expect(generateMock).toHaveBeenCalled()

      const result = await vi.advanceTimersByTimeAsync(5 * 60_000).then(() => pending)
      expect(result).toMatchObject({
        state: 'failed',
        error: 'Generation stalled (no progress for 5 minutes)',
      })
      expect(failGenerationMock).toHaveBeenCalledWith(
        'Generation stalled (no progress for 5 minutes)',
      )
      expect(stopMock).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('buckets items by the requested mode, defaulting to the preset category', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Edit By Prompt', category: 'edit-images' })]

    const { result } = await startAndAwaitSubmit({
      kind: 'edit-image',
      workflow: 'Edit By Prompt',
      prompt: 'make it blue',
    })
    settleDone()
    const settled = await result

    expect(settled.items.every((item) => item.mode === 'imageEdit')).toBe(true)
  })

  it('does not treat a leftover FSM error as this run failing', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    currentState.value = 'error'
    lastError.value = 'previous run died'

    const { result } = await startAndAwaitSubmit({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })
    settleDone()
    const settled = await result

    expect(generateMock).toHaveBeenCalledTimes(1)
    expect(settled.state).toBe('completed')
    expect(settled.items).toHaveLength(1)
  })

  it('fails the run when generate() rejects instead of hanging on the watchdog', async () => {
    presetsFixture.value = [comfyPreset({ name: 'Draft Image' })]
    generateMock.mockRejectedValueOnce(new Error('socket closed'))

    const result = await runArtifact({
      kind: 'create-image',
      workflow: 'Draft Image',
      prompt: 'a castle',
    })

    expect(result).toMatchObject({ state: 'failed', error: 'socket closed' })
    expect(failGenerationMock).toHaveBeenCalledWith('socket closed')
  })
})

describe('artifactKindForMedia', () => {
  it('maps media type and source onto the kind later adapters will key off', () => {
    expect(artifactKindForMedia('image', false)).toBe('create-image')
    expect(artifactKindForMedia('image', true)).toBe('edit-image')
    expect(artifactKindForMedia('video', false)).toBe('create-video')
    expect(artifactKindForMedia('video', true)).toBe('create-video')
    expect(artifactKindForMedia('model3d', false)).toBe('create-3d')
    expect(artifactKindForMedia(undefined, false)).toBe('create-image')
  })
})
