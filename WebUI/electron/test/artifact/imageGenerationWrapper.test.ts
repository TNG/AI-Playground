import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'

// The SUT gets ref/computed from unplugin-auto-import (only `watch` is
// imported explicitly), but vitest.config.ts runs without that plugin —
// expose the two identifiers as globals, exactly what the plugin injects.
Object.assign(globalThis, { computed, ref })

// The store's kernel projection reads window.electronAPI at setup time; with
// an empty stub it no-ops, exactly like a renderer without the artifact IPC.
const cancelIpcMock = vi.fn<(runId?: string) => Promise<void>>().mockResolvedValue()
vi.stubGlobal('window', { electronAPI: { artifact: { cancel: cancelIpcMock } } })

// vi.mock factories are hoisted above every top-level const, so the shared
// proxy helper must live here.
function anyMemberStore() {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === 'symbol') return undefined
        // Calls on an unmodelled member resolve immediately; reads would be a
        // function (truthy), but no setup-level code reads these stores.
        return vi.fn().mockReturnValue(undefined)
      },
    },
  )
}
// The wrapper under test is the real imageGenerationPresets store; everything
// it touches is stubbed. Store mocks return plain objects (no pinia proxy), so
// members are the final values, never refs.
const runArtifactMock = vi.fn<(request: unknown, ctx?: unknown) => Promise<unknown>>()
const errorsReportMock = vi.fn()
const presetsFixture = ref<unknown[]>([])
const activePresetWithVariant = ref<unknown>(null)
const activeVariantName = ref<Record<string, string>>({})

vi.mock('@/assets/js/artifact/runArtifact', () => ({ runArtifact: runArtifactMock }))
vi.mock('@/assets/js/store/comfyUiPresets', () => ({ useComfyUiPresets: () => anyMemberStore() }))
vi.mock('@/assets/js/store/homeAgent', () => ({ useHomeAgent: () => anyMemberStore() }))
vi.mock('@/assets/js/store/dialogs', () => ({
  useDialogStore: () => anyMemberStore(),
  // The runner (mocked above) is the only real consumer; the SUT imports the
  // type only, but keep the runtime export present for safety.
  PresetRequirementsData: undefined,
}))
vi.mock('@/assets/js/store/ui', () => ({ useUIStore: () => anyMemberStore() }))
vi.mock('@/assets/js/store/backendServices', () => ({
  useBackendServices: () => anyMemberStore(),
}))
vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: errorsReportMock, recentErrors: [] }),
}))
vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ state: { COM_GENERATING: 'Generating' } }),
}))
vi.mock('@/assets/js/store/demoMode', () => ({
  // Plain false: a function (truthy) would flip the demo branches on.
  useDemoMode: () => ({ enabled: false }),
}))
vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    get presets() {
      return presetsFixture.value
    },
    get activePresetWithVariant() {
      return activePresetWithVariant.value
    },
    get activeVariantName() {
      return activeVariantName.value
    },
    getFirstVariantName: vi.fn(() => null),
  }),
  presetRequiresUserPrompt: vi.fn(() => false),
}))
vi.mock('@/assets/js/store/demoModeDefaults', () => ({
  getDemoModeInputImage: vi.fn(() => null),
  getDemoModeSketchInputImage: vi.fn(() => null),
  getDemoModeUpscaleInputImage: vi.fn(() => null),
}))
vi.mock('@/lib/utils', () => ({
  imageUrlToDataUri: vi.fn(async (source: string) => source),
  saveImageToMediaInput: vi.fn(async (dataUri: string) => dataUri),
}))
vi.mock('@/lib/laminarSpans', () => ({
  withTraceSpan: (_name: string, fn: () => unknown) => fn(),
}))
vi.mock('@/assets/js/imageGenerationUtils', () => ({
  getMissingComfyuiBackendModels: vi.fn(async () => []),
}))

// Imported late on purpose: a dynamic import runs in source order, so the
// hoisted factories only execute after the mock consts are initialized.
const { useImageGenerationPresets } = await import('@/assets/js/store/imageGenerationPresets')

const comfyPresetFixture = (overrides: Record<string, unknown> = {}) => ({
  name: 'Draft Image',
  type: 'comfy',
  category: 'create-images',
  backend: 'comfyui',
  mediaType: 'image',
  settings: [],
  requiredModels: [],
  ...overrides,
})

describe('imageGenerationPresets.generate (UI wrapper)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    runArtifactMock.mockReset()
    errorsReportMock.mockReset()
    runArtifactMock.mockResolvedValue({ state: 'completed', items: [] })
    presetsFixture.value = []
    activeVariantName.value = {}
    activePresetWithVariant.value = null
  })

  it('maps each panel mode to its artifact kind and passes mode through', async () => {
    activePresetWithVariant.value = comfyPresetFixture()
    const store = useImageGenerationPresets()

    await store.generate('imageGen')
    await store.generate('imageEdit')
    await store.generate('video')

    const kinds = runArtifactMock.mock.calls.map(
      (call) => (call[0] as { kind: string; mode: string }).kind,
    )
    const modes = runArtifactMock.mock.calls.map(
      (call) => (call[0] as { kind: string; mode: string }).mode,
    )
    expect(kinds).toEqual(['create-image', 'edit-image', 'create-video'])
    expect(modes).toEqual(['imageGen', 'imageEdit', 'video'])
  })

  it('forwards form state and the active variant, and resolves with the runner result', async () => {
    activePresetWithVariant.value = comfyPresetFixture({ name: 'Draft Image' })
    activeVariantName.value = { 'Draft Image': 'Pencil' }
    const runnerResult = { state: 'completed', items: ['an-item'] }
    runArtifactMock.mockResolvedValueOnce(runnerResult)

    const store = useImageGenerationPresets()
    store.prompt = 'a castle'
    store.negativePrompt = 'blurry'
    store.seed = 42
    store.width = 1024
    store.height = 768
    store.inferenceSteps = 20
    store.batchSize = 1

    const result = await store.generate('imageGen')

    expect(runArtifactMock).toHaveBeenCalledTimes(1)
    expect(runArtifactMock.mock.calls[0][0]).toMatchObject({
      kind: 'create-image',
      workflow: 'Draft Image',
      variant: 'Pencil',
      prompt: 'a castle',
      negativePrompt: 'blurry',
      params: { seed: 42, width: 1024, height: 768, inferenceSteps: 20, batchSize: 1 },
    })
    expect(result).toBe(runnerResult)
  })

  it('never injects a generic source — panel sources ride the saved inputs', async () => {
    activePresetWithVariant.value = comfyPresetFixture({ category: 'edit-images' })
    const store = useImageGenerationPresets()

    await store.generate('imageEdit')

    expect(runArtifactMock.mock.calls[0][0]).not.toHaveProperty('source')
  })

  it('routes the stop button to the main runner cancel and settles the UI', async () => {
    const store = useImageGenerationPresets()

    store.stopGeneration()

    await vi.waitFor(() => expect(cancelIpcMock).toHaveBeenCalledTimes(1))
    // Locally the FSM leaves the processing state immediately.
    expect(store.processing).toBe(false)
  })

  it('reports generation/no-preset and never reaches the runner without a comfy preset', async () => {
    activePresetWithVariant.value = { name: 'Chat', type: 'chat' }
    const store = useImageGenerationPresets()

    const result = await store.generate('imageGen')

    expect(runArtifactMock).not.toHaveBeenCalled()
    expect(errorsReportMock).toHaveBeenCalledTimes(1)
    expect(result).toBeUndefined()
  })
})
