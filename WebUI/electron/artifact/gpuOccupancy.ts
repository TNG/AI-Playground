/**
 * Main-side GPU occupancy wrap for in-process artifact callers
 * (docs/architecture-target.md §4.1, step 5).
 *
 * Occupancy is a refcount of `withGpuForMedia` holders, not a peek at the
 * runner queue. Parallel Pi tool calls (a spritesheet) all enter this wrap
 * before any of them has submitted — if we only asked "is a run active?" on
 * the way out, the first to finish would reload the LLM while a sibling was
 * still in `stopChatForMedia`. The last holder out does the swap-back.
 *
 * Renderer drivers (panel, chat tools, Home Agent) keep their own stop/return
 * wrap until step 7's orchestrator collects GPU policy: they know to wait for
 * an in-flight chat stream (`waitForInferenceIdle`) before killing llama.cpp.
 * In-process agent tools have no renderer to ask, so this is the same handoff
 * on main. The two paths must not wrap the same run.
 */
import { appLoggerInstance } from '../logging/logger'
import { artifactRunActive, artifactRunsQueued } from './runner'
import { freeMemoryAndUnloadModels, type ComfyClientDeps } from './comfyClient'

const appLogger = appLoggerInstance

export type GpuOccupancyDeps = {
  /** Stop the running chat LLM/embedding servers (OVMS keeps speech servers up). */
  stopChatForMedia(): Promise<void>
  /** Load the chat model again — the main side of `ensureBackendReadiness`. */
  restartChatBackend(): Promise<void>
  comfyBaseUrl(): string | null
  getComfyClientDeps(): ComfyClientDeps
}

let gpuDeps: GpuOccupancyDeps | null = null
let occupancy = 0
let gpuHeldByMedia = false

export function setGpuOccupancyDeps(deps: GpuOccupancyDeps): void {
  gpuDeps = deps
}

// Test seam.
export function resetGpuOccupancyForTest(): void {
  gpuDeps = null
  occupancy = 0
  gpuHeldByMedia = false
}

/** How many `withGpuForMedia` callers currently hold the GPU for media. */
export function mediaGpuOccupancy(): number {
  return occupancy
}

/**
 * Runs `fn` (a submit-then-await around the artifact runner) with the GPU
 * handed to media. `keepModelsLoaded` is the user's developer setting, carried
 * per run by the caller. Failures in the swap-back are logged, never thrown:
 * this runs in a `finally`, where throwing would replace a finished result
 * with a cleanup error — and the chat model comes back with the next turn
 * anyway.
 */
export async function withGpuForMedia<T>(
  fn: () => Promise<T>,
  options: { keepModelsLoaded: boolean },
): Promise<T> {
  if (!gpuDeps) return fn()
  const deps = gpuDeps

  occupancy += 1
  try {
    if (!options.keepModelsLoaded && !gpuHeldByMedia) {
      gpuHeldByMedia = true
      await deps.stopChatForMedia()
    }
    return await fn()
  } finally {
    occupancy -= 1
    if (gpuHeldByMedia && occupancy === 0 && !artifactRunActive() && artifactRunsQueued() === 0) {
      gpuHeldByMedia = false
      await swapBack(deps)
    }
  }
}

async function swapBack(deps: GpuOccupancyDeps): Promise<void> {
  try {
    const baseUrl = deps.comfyBaseUrl()
    if (baseUrl) await freeMemoryAndUnloadModels(baseUrl, deps.getComfyClientDeps())
  } catch (error) {
    appLogger.warn(`Freeing image models failed: ${String(error)}`, 'electron-backend')
  }
  try {
    await deps.restartChatBackend()
  } catch (error) {
    appLogger.warn(
      `Could not load the chat model again after generating: ${String(error)}`,
      'electron-backend',
    )
  }
}
