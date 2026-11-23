import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useModelLibrary } from '@/assets/js/store/modelLibrary'
import { useModelPreferences } from '@/assets/js/store/modelPreferences'
import { modelEntryId } from '@/assets/js/models/library'
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
  overrides: Partial<Omit<ScannedModel, 'name'>> = {},
): ScannedModel => ({
  pathKey: overrides.useCase === 'embedding' ? 'embedding' : 'checkpoints',
  useCase: 'media',
  serviceBackend: 'comfyui',
  name: `org/repo/${name}`,
  absolutePath: `/models/${name}`,
  sizeBytes: 100,
  modifiedAt: 1_000,
  isDirectory: false,
  ...overrides,
})

let disk: ScannedModel[] = []

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
  beforeEach(() => {
    disk = [
      scanned('flux.safetensors'),
      scanned('sdxl.safetensors'),
      scanned('lcm.xml', { serviceBackend: 'openvino' }),
      scanned('bge.gguf', { useCase: 'embedding', serviceBackend: 'llama_cpp' }),
    ]
  })

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

describe('model library sort', () => {
  beforeEach(() => {
    disk = [
      scanned('b.safetensors', { sizeBytes: 300, modifiedAt: 1_000 }),
      scanned('a.safetensors', { sizeBytes: 100, modifiedAt: 3_000 }),
      scanned('c.safetensors', { sizeBytes: 200, modifiedAt: 2_000 }),
    ]
  })

  it('sorts by the key and direction it is set to', async () => {
    const library = await loadedLibrary()
    library.setFilters({ useCase: 'media' })

    library.setSort({ key: 'size', direction: 'desc' })
    expect(labels(library)).toEqual(['b.safetensors', 'c.safetensors', 'a.safetensors'])

    library.setSort({ key: 'modified', direction: 'asc' })
    expect(labels(library)).toEqual(['b.safetensors', 'c.safetensors', 'a.safetensors'])

    library.setSort({ key: 'name', direction: 'desc' })
    expect(labels(library)).toEqual(['c.safetensors', 'b.safetensors', 'a.safetensors'])
  })

  it('keeps favorites on top whatever the sort', async () => {
    const library = await loadedLibrary()
    library.setFilters({ useCase: 'media' })
    await useModelPreferences().setFavorite(
      modelEntryId('checkpoints', 'org/repo/a.safetensors'),
      true,
    )

    library.setSort({ key: 'size', direction: 'desc' })

    expect(labels(library)[0]).toBe('a.safetensors')
  })
})
