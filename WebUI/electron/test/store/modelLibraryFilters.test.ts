import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useModelLibrary } from '@/assets/js/store/modelLibrary'
import type { ScannedModel } from '@/assets/js/models/types'

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({ models: [], refreshModels: async () => {} }),
}))

vi.mock('@/assets/js/store/presets', () => ({ usePresets: () => ({ presets: [] }) }))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({ llmModels: [] }),
}))

vi.mock('@/assets/js/store/globalSetup', () => ({ useGlobalSetup: () => ({ state: {} }) }))

vi.mock('@/assets/js/store/productMode', () => ({
  useProductMode: () => ({ isNvidiaModeSelected: false }),
}))

vi.mock('@/lib/useLlamaCppVramFit', () => ({
  useVramFitLevels: () => ({ levelOf: () => null }),
}))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: () => {} }) }))

const scanned = (
  name: string,
  useCase: ScannedModel['useCase'],
  serviceBackend: ScannedModel['serviceBackend'],
): ScannedModel => ({
  pathKey: useCase === 'embedding' ? 'embedding' : 'checkpoints',
  useCase,
  serviceBackend,
  name: `org/repo/${name}`,
  absolutePath: `/models/${name}`,
  sizeBytes: 100,
  modifiedAt: 1_000,
  isDirectory: false,
})

const disk = [
  scanned('flux.safetensors', 'media', 'comfyui'),
  scanned('sdxl.safetensors', 'media', 'comfyui'),
  scanned('lcm.xml', 'media', 'openvino'),
  scanned('bge.gguf', 'embedding', 'llama_cpp'),
]

beforeEach(() => {
  setActivePinia(createPinia())
  ;(globalThis as Record<string, unknown>).window = {
    electronAPI: {
      scanModelLibrary: async () => ({ models: disk, failedPathKeys: [] }),
      preferences: {
        read: async () => ({ success: true, sections: {} }),
        migrate: async () => ({ success: true }),
        write: async () => ({ success: true }),
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }
})

async function loadedLibrary() {
  const library = useModelLibrary()
  await library.refresh()
  return library
}

const labels = (library: ReturnType<typeof useModelLibrary>) =>
  library.visibleEntries.map((entry) => entry.label)

describe('model library filters', () => {
  it('counts the models in the chosen use case, whatever else filters the list', async () => {
    const library = await loadedLibrary()
    library.setFilters({ useCase: 'media' })
    library.setFilters({ search: 'flux' })

    expect(library.visibleEntries).toHaveLength(1)
    expect(library.useCaseTotal).toBe(3)
  })

  it('says whether a filter other than the use case is active', async () => {
    const library = await loadedLibrary()
    library.setFilters({ useCase: 'media' })
    expect(library.filtersActive).toBe(false)

    library.setFilters({ backend: 'openvino' })
    expect(library.filtersActive).toBe(true)
  })

  it('clears every filter but keeps the chosen use case', async () => {
    const library = await loadedLibrary()
    library.setFilters({ useCase: 'media' })
    library.setFilters({ backend: 'comfyui', search: 'sdxl', downloadState: 'downloaded' })
    expect(labels(library)).toEqual(['sdxl.safetensors'])

    library.clearFilters()

    expect(library.filters.useCase).toBe('media')
    expect(library.filtersActive).toBe(false)
    expect(labels(library).sort()).toEqual(['flux.safetensors', 'lcm.xml', 'sdxl.safetensors'])
  })
})
