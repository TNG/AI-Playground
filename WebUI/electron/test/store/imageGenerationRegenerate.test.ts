import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Only the store's collaborators are faked here.

const { errorsReport } = vi.hoisted(() => ({ errorsReport: vi.fn() }))
const sessionsApi = vi.hoisted(() => ({
  openSessionId: 's1' as string | null,
  ensureOpenSession: vi.fn(),
  readyWorkspaceForTurn: vi.fn(async () => true),
  beginMediaTurn: vi.fn(),
  endMediaTurn: vi.fn(),
  forgetTimelineMessages: vi.fn(),
}))
const galleryApi = vi.hoisted(() => ({ removeTurn: vi.fn() }))
const runArtifactMock = vi.hoisted(() => vi.fn())

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
  useBackendServices: () => ({
    resetLastUsedInferenceBackend: vi.fn(async () => {}),
    updateLastUsedBackend: vi.fn(async () => {}),
  }),
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
  runArtifact: runArtifactMock,
}))

vi.mock('@/assets/js/store/demoModeDefaults', () => ({
  getDemoModeInputImage: () => null,
  getDemoModeSketchInputImage: () => null,
  getDemoModeUpscaleInputImage: () => null,
}))

vi.mock('@/assets/js/store/sessions', () => ({
  useSessions: () => sessionsApi,
}))

vi.mock('@/assets/js/store/gallery', () => ({
  useGallery: () => galleryApi,
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

const preferencesApi = {
  read: vi.fn(
    async (): Promise<
      { success: true; sections: Record<string, unknown> } | { success: false; error: string }
    > => ({ success: true, sections: {} }),
  ),
  migrate: vi.fn(async (): Promise<{ success: true } | { success: false; error: string }> => ({
    success: true,
  })),
  write: vi.fn(async (): Promise<{ success: true } | { success: false; error: string }> => ({
    success: true,
  })),
}

beforeEach(() => {
  setActivePinia(createPinia())
  const localStorageShim = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  }
  globalThis.localStorage = localStorageShim as unknown as Storage
  globalThis.sessionStorage = localStorageShim as unknown as Storage
  globalThis.window = {
    electronAPI: { mediaItems: mediaItemsApi, preferences: preferencesApi },
    __AIPG_DEMO_MODE__: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & typeof globalThis
  vi.clearAllMocks()
  mediaItemsApi.bootstrap.mockResolvedValue({ status: 'empty' })
  preferencesApi.read.mockResolvedValue({ success: true, sections: {} })
  sessionsApi.ensureOpenSession.mockResolvedValue('s1')
  runArtifactMock.mockResolvedValue({ state: 'completed', items: [] })
})

afterEach(() => {
  // @ts-expect-error test teardown of the fakes
  delete globalThis.window
  // @ts-expect-error test teardown of the fakes
  delete globalThis.localStorage
  // @ts-expect-error test teardown of the fakes
  delete globalThis.sessionStorage
})

const { useImageGenerationPresets } = await import('@/assets/js/store/imageGenerationPresets')

type Store = ReturnType<typeof useImageGenerationPresets>

const OLD_URL = 'aipg-media://sessions/s1/files/old.png'

const oldItem = {
  id: 'old-1',
  type: 'image',
  state: 'done',
  mode: 'imageGen',
  imageUrl: OLD_URL,
  settings: { preset: 'Pro Image' },
  createdAt: 1,
} as never

const rerunOf = (overrides: Record<string, unknown> = {}) =>
  ({
    mode: 'imageGen',
    workflow: 'Pro Image',
    prompt: 'a castle',
    params: { seed: -1 },
    inputs: {},
    messageIds: ['p1', 'a1'],
    fileUrls: [OLD_URL],
    ...overrides,
  }) as never

const storeWithOldItem = async (): Promise<Store> => {
  mediaItemsApi.bootstrap.mockResolvedValue({ status: 'ok', items: [oldItem] })
  const store = useImageGenerationPresets()
  await store.init()
  return store
}

describe('useImageGenerationPresets regenerate replacing the turn', () => {
  it("forgets the replaced turn's messages before its replacement settles", async () => {
    const store = await storeWithOldItem()

    await store.regenerate(rerunOf())

    // The old pair leaves the open timeline first; the file copy follows the settle.
    expect(sessionsApi.forgetTimelineMessages).toHaveBeenCalledWith('s1', ['p1', 'a1'])
    expect(sessionsApi.forgetTimelineMessages.mock.invocationCallOrder[0]).toBeLessThan(
      galleryApi.removeTurn.mock.invocationCallOrder[0],
    )
  })

  it("takes the replaced turn's messages out of the Session and its files out of the store once the rerun settles", async () => {
    const store = await storeWithOldItem()

    await store.regenerate(rerunOf())

    expect(sessionsApi.beginMediaTurn).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ preset: 'Pro Image', prompt: 'a castle', mode: 'imageGen' }),
    )
    expect(galleryApi.removeTurn).toHaveBeenCalledWith('s1', {
      messageIds: ['p1', 'a1'],
      fileUrls: [OLD_URL],
    })
    // The panel's strip drops the deleted output, selection included.
    expect(store.generatedImages).toEqual([])
    expect(sessionsApi.endMediaTurn).toHaveBeenCalledWith('s1', expect.any(String))
  })

  it('keeps the replaced turn out even when the rerun fails: its own failed turn stands in', async () => {
    runArtifactMock.mockResolvedValue({ state: 'failed', items: [], error: 'out of memory' })
    const store = await storeWithOldItem()

    await store.regenerate(rerunOf())

    expect(galleryApi.removeTurn).toHaveBeenCalledWith('s1', {
      messageIds: ['p1', 'a1'],
      fileUrls: [OLD_URL],
    })
    expect(store.generatedImages).toEqual([])
  })

  it('drops a replaced item the panel had selected', async () => {
    const store = await storeWithOldItem()
    store.selectedGeneratedImageId = 'old-1'
    expect(store.generatedImages).toHaveLength(1)

    await store.regenerate(rerunOf())

    expect(store.generatedImages).toEqual([])
    expect(store.selectedGeneratedImageId).toBeNull()
  })

  it('replaces through an edited prompt too, running it with the new text', async () => {
    const store = await storeWithOldItem()

    await store.regenerate(rerunOf({ prompt: 'a brighter castle' }))

    expect(runArtifactMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'a brighter castle' }),
      expect.objectContaining({ sessionId: 's1' }),
    )
    expect(galleryApi.removeTurn).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ messageIds: ['p1', 'a1'] }),
    )
  })
})

describe('useImageGenerationPresets deleteTurn', () => {
  it("takes the newest media turn's messages out of the Session and its files out of the store", async () => {
    const store = await storeWithOldItem()

    await store.deleteTurn({ owner: 'media', messageIds: ['p1', 'a1'], fileUrls: [OLD_URL] })

    expect(galleryApi.removeTurn).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ messageIds: ['p1', 'a1'], fileUrls: [OLD_URL] }),
    )
    expect(store.generatedImages).toEqual([])
    expect(store.selectedGeneratedImageId).toBeNull()
  })

  it('takes a failed turn out without files to delete', async () => {
    mediaItemsApi.bootstrap.mockResolvedValue({ status: 'empty' })
    const store = useImageGenerationPresets()
    await store.init()

    await store.deleteTurn({ owner: 'media', messageIds: ['p1', 'a1'], fileUrls: [] })

    expect(galleryApi.removeTurn).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ messageIds: ['p1', 'a1'], fileUrls: [] }),
    )
  })

  it('takes a turn of no open Session out of nothing', async () => {
    const store = await storeWithOldItem()
    sessionsApi.openSessionId = null
    try {
      await store.deleteTurn({ owner: 'media', messageIds: ['p1', 'a1'], fileUrls: [OLD_URL] })

      expect(galleryApi.removeTurn).not.toHaveBeenCalled()
      expect(store.generatedImages).toHaveLength(1)
    } finally {
      sessionsApi.openSessionId = 's1'
    }
  })
})
