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

const scanned = (name: string, sizeBytes: number, modifiedAt: number): ScannedModel => ({
  pathKey: 'checkpoints',
  useCase: 'media',
  serviceBackend: 'comfyui',
  name: `org/repo/${name}`,
  absolutePath: `/models/${name}`,
  sizeBytes,
  modifiedAt,
  isDirectory: false,
})

const disk = [
  scanned('b.safetensors', 300, 1_000),
  scanned('a.safetensors', 100, 3_000),
  scanned('c.safetensors', 200, 2_000),
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
  library.setFilters({ useCase: 'media' })
  return library
}

const labels = (library: ReturnType<typeof useModelLibrary>) =>
  library.visibleEntries.map((entry) => entry.label)

describe('model library sort', () => {
  it('sorts by the key and direction it is set to', async () => {
    const library = await loadedLibrary()

    library.setSort({ key: 'size', direction: 'desc' })
    expect(labels(library)).toEqual(['b.safetensors', 'c.safetensors', 'a.safetensors'])

    library.setSort({ key: 'modified', direction: 'asc' })
    expect(labels(library)).toEqual(['b.safetensors', 'c.safetensors', 'a.safetensors'])

    library.setSort({ key: 'name', direction: 'desc' })
    expect(labels(library)).toEqual(['c.safetensors', 'b.safetensors', 'a.safetensors'])
  })

  it('keeps favorites on top whatever the sort', async () => {
    const library = await loadedLibrary()
    await useModelPreferences().setFavorite(
      modelEntryId('checkpoints', 'org/repo/a.safetensors'),
      true,
    )

    library.setSort({ key: 'size', direction: 'desc' })

    expect(labels(library)[0]).toBe('a.safetensors')
  })
})
