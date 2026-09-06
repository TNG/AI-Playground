import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The renderer half of step 8's generated-media slice (architecture-target
// §6.1): the store hydrates the gallery from the kernel's record files before
// mount, uploads the legacy Pinia-persisted gallery once (then slims it out
// of the still-persisted key), and writes through through a debounced deep
// watch — only terminal `done` items are durable, deletes are idempotent
// diffs, and nothing writes before hydration.

const { errorsReport } = vi.hoisted(() => ({ errorsReport: vi.fn() }))

vi.mock('@/assets/js/store/comfyUiPresets', () => ({
  useComfyUiPresets: () => ({}),
}))

vi.mock('@/assets/js/store/demoMode', () => ({
  useDemoMode: () => ({ enabled: false }),
}))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ state: { COM_GENERATING: 'Generating' } }),
}))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReport }),
}))

vi.mock('@/assets/js/store/backendServices', () => ({
  useBackendServices: () => ({}),
}))

vi.mock('@/assets/js/projection/kernelProjection', () => ({
  connectKernelEventStream: () => ({ ready: Promise.resolve(), dispose: vi.fn() }),
}))

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({ presets: [], activeVariantName: {} }),
  presetRequiresUserPrompt: vi.fn(() => false),
}))

vi.mock('@/assets/js/store/ui', () => ({
  useUIStore: () => ({}),
}))

vi.mock('@/assets/js/store/imageGenerationUtils', () => ({
  getMissingComfyuiBackendModels: vi.fn(async () => []),
}))

vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload: vi.fn(async () => {}),
}))

vi.mock('@/lib/utils', () => ({
  imageUrlToDataUri: vi.fn(async () => 'data:image/png;base64,AAAA'),
  saveImageToMediaInput: vi.fn(async () => 'aipg-media://media/input/copied.png'),
}))

vi.mock('@/lib/laminarSpans', () => ({
  withTraceSpan: vi.fn((_name: string, fn: () => unknown) => fn()),
}))

vi.mock('@/assets/js/artifact/runArtifact', () => ({
  runArtifact: vi.fn(async () => ({ status: 'completed' })),
}))

vi.mock('@/assets/js/store/demoModeDefaults', () => ({
  getDemoModeInputImage: () => null,
  getDemoModeSketchInputImage: () => null,
  getDemoModeUpscaleInputImage: () => null,
}))

const mediaItemsApi = {
  bootstrap: vi.fn(),
  migrate: vi.fn(),
  save: vi.fn(async (_items: unknown[]): Promise<{ success: boolean; error?: string }> => ({
    success: true,
  })),
  delete: vi.fn(async (_ids: string[]): Promise<{ success: boolean; error?: string }> => ({
    success: true,
  })),
}

let storage: Map<string, string>
let windowListeners: Record<string, Array<() => void>>

function fakeWindow(): void {
  storage = new Map()
  windowListeners = {}
  const localStorageShim = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }
  globalThis.localStorage = localStorageShim as unknown as Storage
  globalThis.sessionStorage = localStorageShim as unknown as Storage
  globalThis.window = {
    electronAPI: { mediaItems: mediaItemsApi },
    __AIPG_DEMO_MODE__: false,
    addEventListener: (event: string, handler: () => void) => {
      ;(windowListeners[event] ??= []).push(handler)
    },
    removeEventListener: (event: string, handler: () => void) => {
      windowListeners[event] = (windowListeners[event] ?? []).filter((h) => h !== handler)
    },
  } as unknown as Window & typeof globalThis
}

beforeEach(() => {
  setActivePinia(createPinia())
  fakeWindow()
  vi.useFakeTimers()
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  // @ts-expect-error test teardown of the fakes
  delete globalThis.window
  // @ts-expect-error test teardown of the fakes
  delete globalThis.localStorage
  // @ts-expect-error test teardown of the fakes
  delete globalThis.sessionStorage
})

const { useImageGenerationPresets } = await import('@/assets/js/store/imageGenerationPresets')

type Store = ReturnType<typeof useImageGenerationPresets>

const doneImage = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    id,
    type: 'image',
    state: 'done',
    mode: 'imageGen',
    imageUrl: `aipg-media://media/${id}.png`,
    settings: { preset: 'Pro Image' },
    createdAt: 1,
    ...overrides,
  }) as never

const seededKey = (gallery: unknown[]): void => {
  storage.set(
    'imageGenerationPresets',
    JSON.stringify({
      settingsPerPreset: { 'Pro Image': { width: 1024 } },
      comfyInputsPerPreset: {},
      generatedImages: gallery,
    }),
  )
}

const advanceFlush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(350)
}

describe('useImageGenerationPresets media-record hydration', () => {
  it('hydrates the gallery from the kernel files and marks itself hydrated', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'ok', items: [doneImage('item-1')] })
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(store.generatedImages).toHaveLength(1)
    expect(store.mediaRecordsHydrated).toBe(true)
    expect(mediaItemsApi.migrate).not.toHaveBeenCalled()
    // init is idempotent — a second call does not re-hydrate.
    await store.init()
    expect(mediaItemsApi.bootstrap).toHaveBeenCalledTimes(1)
  })

  it('uploads the legacy gallery once and slims it out of the still-persisted key', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'empty' })
    mediaItemsApi.migrate.mockResolvedValue({
      status: 'ok',
      items: [doneImage('legacy-1')],
    })
    seededKey([doneImage('legacy-1')])
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(mediaItemsApi.migrate).toHaveBeenCalledTimes(1)
    expect(store.generatedImages.map((item) => (item as { id: string }).id)).toEqual(['legacy-1'])
    const key = JSON.parse(storage.get('imageGenerationPresets') ?? '{}') as Record<string, unknown>
    expect(key.generatedImages).toBeUndefined()
    expect(key.settingsPerPreset).toEqual({ 'Pro Image': { width: 1024 } })
  })

  it('merges a stranded legacy gallery even when the files already hold items', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({
      status: 'ok',
      items: [doneImage('session-item')],
    })
    mediaItemsApi.migrate.mockResolvedValue({
      status: 'ok',
      items: [doneImage('legacy-item'), doneImage('session-item')],
    })
    seededKey([doneImage('legacy-item')])
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(mediaItemsApi.migrate).toHaveBeenCalledTimes(1)
    const ids = store.generatedImages.map((item) => (item as { id: string }).id)
    expect(ids).toEqual(['legacy-item', 'session-item'])
    expect(
      (JSON.parse(storage.get('imageGenerationPresets') ?? '{}') as Record<string, unknown>)
        .generatedImages,
    ).toBeUndefined()
  })

  it('keeps the legacy gallery in the key when the upload fails, to retry next boot', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'empty' })
    mediaItemsApi.migrate.mockResolvedValue({ status: 'error', error: 'disk full' })
    seededKey([doneImage('legacy-1')])
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(errorsReport).toHaveBeenCalled()
    const key = JSON.parse(storage.get('imageGenerationPresets') ?? '{}') as Record<string, unknown>
    expect(Array.isArray(key.generatedImages)).toBe(true)
    expect(store.mediaRecordsHydrated).toBe(true)
  })

  it('slims an empty legacy gallery payload and reports a failed bootstrap', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'error', error: 'store not ready' })
    seededKey([])
    const store: Store = useImageGenerationPresets()

    await store.init()

    expect(errorsReport).toHaveBeenCalled()
    expect(store.mediaRecordsHydrated).toBe(true)
    expect(store.generatedImages).toEqual([])
  })
})

describe('useImageGenerationPresets media-record write-through', () => {
  async function hydratedStore(): Promise<Store> {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'ok', items: [] })
    const store: Store = useImageGenerationPresets()
    await store.init()
    return store
  }

  it('writes nothing before init has hydrated', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'empty' })
    const store: Store = useImageGenerationPresets()

    store.updateImage(doneImage('item-1'))
    await advanceFlush()

    expect(mediaItemsApi.save).not.toHaveBeenCalled()
  })

  it('saves a done item once the array changes, and does not re-save unchanged items', async () => {
    const store = await hydratedStore()

    store.updateImage(doneImage('item-1'))
    await advanceFlush()
    expect(mediaItemsApi.save).toHaveBeenCalledTimes(1)
    expect(mediaItemsApi.save.mock.calls[0][0]).toHaveLength(1)

    // No further change: the next flush is a no-op. (A fresh object, as the
    // artifact events always deliver — Vue does not trigger on re-setting
    // the identical reference.)
    store.updateImage({ ...store.generatedImages[0] })
    await advanceFlush()
    expect(mediaItemsApi.save).toHaveBeenCalledTimes(1)
  })

  it('never persists an item that is not done', async () => {
    const store = await hydratedStore()

    store.updateImage(doneImage('item-1', { state: 'generating' }))
    await advanceFlush()

    expect(mediaItemsApi.save).not.toHaveBeenCalled()
  })

  it('deletes a removed id and mode-scoped ids through the diff', async () => {
    const store = await hydratedStore()
    store.updateImage(doneImage('keep', { mode: 'imageGen' }))
    store.updateImage(doneImage('gone', { mode: 'imageGen' }))
    store.updateImage(
      doneImage('video-gone', {
        mode: 'video',
        type: 'video',
        videoUrl: 'aipg-media://media/v.mp4',
      }),
    )
    await advanceFlush()
    expect(mediaItemsApi.save).toHaveBeenCalledTimes(1)

    store.deleteImage('gone')
    await advanceFlush()
    expect(mediaItemsApi.delete).toHaveBeenCalledWith(['gone'])

    store.deleteAllImagesForMode('video')
    await advanceFlush()
    expect(mediaItemsApi.delete).toHaveBeenLastCalledWith(['video-gone'])

    store.deleteAllImages()
    await advanceFlush()
    expect(mediaItemsApi.delete).toHaveBeenLastCalledWith(['keep'])
  })

  it('retries a save that the file store rejected', async () => {
    const store = await hydratedStore()
    mediaItemsApi.save.mockResolvedValueOnce({ success: false, error: 'locked' })

    store.updateImage(doneImage('item-1'))
    await advanceFlush()
    expect(errorsReport).toHaveBeenCalled()

    store.updateImage({ ...store.generatedImages[0] })
    await advanceFlush()
    expect(mediaItemsApi.save).toHaveBeenCalledTimes(2)
    expect(mediaItemsApi.save.mock.calls[1][0]).toHaveLength(1)
  })

  it('flushes immediately on beforeunload so a quit does not drop the debounce window', async () => {
    const store = await hydratedStore()
    const saved = new Promise<void>((resolve) => {
      mediaItemsApi.save.mockImplementation(async () => {
        resolve()
        return { success: true }
      })
    })

    store.updateImage(doneImage('item-1'))
    expect(mediaItemsApi.save).not.toHaveBeenCalled()
    for (const handler of windowListeners.beforeunload ?? []) handler()
    await saved

    expect(mediaItemsApi.save).toHaveBeenCalledTimes(1)
    expect(mediaItemsApi.save.mock.calls[0][0]).toHaveLength(1)
  })
})
