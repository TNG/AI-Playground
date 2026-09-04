import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../artifact/runner', () => ({
  artifactRunActive: vi.fn(() => false),
  artifactRunsQueued: vi.fn(() => 0),
}))

vi.mock('../../artifact/comfyClient', async (importOriginal) => ({
  ...(await importOriginal()),
  freeMemoryAndUnloadModels: vi.fn(async () => {}),
}))

import {
  resetGpuOccupancyForTest,
  setGpuOccupancyDeps,
  withGpuForMedia,
  type GpuOccupancyDeps,
} from '../../artifact/gpuOccupancy'
import { artifactRunActive, artifactRunsQueued } from '../../artifact/runner'
import { freeMemoryAndUnloadModels } from '../../artifact/comfyClient'

function deps(overrides: Partial<GpuOccupancyDeps> = {}): GpuOccupancyDeps {
  return {
    stopChatForMedia: vi.fn(async () => {}),
    restartChatBackend: vi.fn(async () => {}),
    comfyBaseUrl: () => 'http://127.0.0.1:49123',
    getComfyClientDeps: () => ({
      getServiceBaseUrl: () => 'http://127.0.0.1:49123',
      getToken: () => 't',
    }),
    ...overrides,
  }
}

describe('withGpuForMedia', () => {
  beforeEach(() => {
    vi.mocked(artifactRunActive).mockReturnValue(false)
    vi.mocked(artifactRunsQueued).mockReturnValue(0)
    vi.mocked(freeMemoryAndUnloadModels).mockClear()
  })

  afterEach(() => {
    resetGpuOccupancyForTest()
  })

  it('returns the wrapped result unchanged when no deps are wired', async () => {
    const result = await withGpuForMedia(async () => 'kept', { keepModelsLoaded: false })
    expect(result).toBe('kept')
  })

  it('swaps the LLM off on the way in and reloads it on the way out', async () => {
    const d = deps()
    setGpuOccupancyDeps(d)
    const result = await withGpuForMedia(async () => 'generated', { keepModelsLoaded: false })
    expect(result).toBe('generated')
    expect(d.stopChatForMedia).toHaveBeenCalledTimes(1)
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
    expect(freeMemoryAndUnloadModels).toHaveBeenCalledTimes(1)
  })

  it('does nothing but run when models are kept loaded', async () => {
    const d = deps()
    setGpuOccupancyDeps(d)
    await withGpuForMedia(async () => 'generated', { keepModelsLoaded: true })
    expect(d.stopChatForMedia).not.toHaveBeenCalled()
    expect(d.restartChatBackend).not.toHaveBeenCalled()
    expect(freeMemoryAndUnloadModels).not.toHaveBeenCalled()
  })

  it('skips the swap back while more artifact runs are waiting', async () => {
    const d = deps()
    setGpuOccupancyDeps(d)
    vi.mocked(artifactRunsQueued).mockReturnValue(2)
    await withGpuForMedia(async () => 'generated', { keepModelsLoaded: false })
    expect(d.restartChatBackend).not.toHaveBeenCalled()
    expect(freeMemoryAndUnloadModels).not.toHaveBeenCalled()
  })

  it('skips the swap back while another artifact run is active', async () => {
    const d = deps()
    setGpuOccupancyDeps(d)
    vi.mocked(artifactRunActive).mockReturnValue(true)
    await withGpuForMedia(async () => 'generated', { keepModelsLoaded: false })
    expect(d.restartChatBackend).not.toHaveBeenCalled()
    expect(freeMemoryAndUnloadModels).not.toHaveBeenCalled()
  })

  it('still swaps back when the wrapped run throws', async () => {
    const d = deps()
    setGpuOccupancyDeps(d)
    await expect(
      withGpuForMedia(async () => Promise.reject(new Error('run failed')), {
        keepModelsLoaded: false,
      }),
    ).rejects.toThrow('run failed')
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
  })

  it('logs, never throws, when the reload fails', async () => {
    const d = deps({ restartChatBackend: vi.fn(() => Promise.reject(new Error('reload failed'))) })
    setGpuOccupancyDeps(d)
    const result = await withGpuForMedia(async () => 'generated', { keepModelsLoaded: false })
    expect(result).toBe('generated')
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
  })
})
