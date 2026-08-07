import { describe, it, expect, vi, beforeEach } from 'vitest'
import os from 'node:os'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}))

vi.mock('../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

// The module keeps one shutdown per process by design, so every test needs a
// fresh copy of it.
const freshShutdown = async () => {
  vi.resetModules()
  return import('../shutdown.ts')
}

describe('shutdownBackends', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs steps in registration order', async () => {
    const { registerShutdownStep, shutdownBackends } = await freshShutdown()
    const order: string[] = []
    registerShutdownStep({ name: 'windows', run: () => void order.push('windows') })
    registerShutdownStep({
      name: 'services',
      run: async () => {
        await Promise.resolve()
        order.push('services')
      },
    })

    await shutdownBackends({ appLogger: silentLogger })

    expect(order).toEqual(['windows', 'services'])
  })

  it('runs each step once no matter how many exit paths call it', async () => {
    const { registerShutdownStep, shutdownBackends } = await freshShutdown()
    const run = vi.fn()
    registerShutdownStep({ name: 'services', run })

    await Promise.all([
      shutdownBackends({ appLogger: silentLogger }),
      shutdownBackends({ appLogger: silentLogger }),
    ])
    await shutdownBackends({ appLogger: silentLogger })

    expect(run).toHaveBeenCalledTimes(1)
  })

  it('continues past a step that throws', async () => {
    const { registerShutdownStep, shutdownBackends } = await freshShutdown()
    const later = vi.fn()
    registerShutdownStep({
      name: 'wedged',
      run: () => {
        throw new Error('backend refused to stop')
      },
    })
    registerShutdownStep({ name: 'later', run: later })

    await shutdownBackends({ appLogger: silentLogger })

    expect(later).toHaveBeenCalledOnce()
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('backend refused to stop'),
      expect.anything(),
    )
  })

  it('stops waiting on a hanging step instead of blocking quit forever', async () => {
    const { registerShutdownStep, shutdownBackends } = await freshShutdown()
    const later = vi.fn()
    registerShutdownStep({ name: 'hanging', run: () => new Promise<void>(() => {}) })
    registerShutdownStep({ name: 'later', run: later })

    await shutdownBackends({ timeoutMs: 50, appLogger: silentLogger })

    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('hanging did not finish'),
      expect.anything(),
    )
    // The budget is for the whole teardown, so a wedged backend eats what is
    // left of it rather than delaying the exit further.
    expect(later).not.toHaveBeenCalled()
  })

  it('reports that it is shutting down, so respawns can be suppressed', async () => {
    const { isShuttingDown, registerShutdownStep, shutdownBackends } = await freshShutdown()
    let duringStep: boolean | null = null
    registerShutdownStep({
      name: 'observer',
      run: () => {
        duringStep = isShuttingDown()
      },
    })

    expect(isShuttingDown()).toBe(false)
    await shutdownBackends({ appLogger: silentLogger })

    expect(duringStep).toBe(true)
    expect(isShuttingDown()).toBe(true)
  })
})
