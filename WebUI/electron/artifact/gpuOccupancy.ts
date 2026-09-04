/**
 * Main-side GPU occupancy wrap for in-process artifact callers
 * (docs/architecture-target.md §4.1, step 5).
 *
 * The renderer drivers (panel, chat tools, Home Agent) keep their own
 * stop/return wrap — they know the chat idle state and the reload params. The
 * in-process agent tools have no renderer to ask, so this is the same handoff
 * on main: with "keep models loaded" off, a media run swaps the chat LLM off
 * the GPU on the way in and gives the GPU back on the way out. A run that sees
 * more artifact runs waiting skips the swap back — the last one out does the
 * cleanup, so a spritesheet costs one swap instead of one per sprite.
 *
 * GPU policy stays with callers until step 7's orchestrator collects it.
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

export function setGpuOccupancyDeps(deps: GpuOccupancyDeps): void {
  gpuDeps = deps
}

// Test seam.
export function resetGpuOccupancyForTest(): void {
  gpuDeps = null
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

  let swapped = false
  if (!options.keepModelsLoaded) {
    await deps.stopChatForMedia()
    swapped = true
  }

  let result: T
  try {
    result = await fn()
  } finally {
    // Another run (already started or waiting in the runner's queue) still
    // wants the GPU where it is.
    if (swapped && !artifactRunActive() && artifactRunsQueued() === 0) {
      await swapBack(deps)
    }
  }
  return result
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
