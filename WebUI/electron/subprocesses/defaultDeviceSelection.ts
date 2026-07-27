import { pickBestDeviceId } from './hardwareDiscovery.ts'
import { bestNameMatch } from './deviceArch.ts'
import { appLoggerInstance as appLogger } from '../logging/logger.ts'
import type { PreferredDevice } from '../main.ts'

// Bridges backend services (which mutate the shared LocalSettings object while
// auto-selecting a default device) to main.ts's disk-persistence routine,
// without threading a callback through every service constructor.
let persistFn: (() => void) | null = null

export function registerSettingsPersist(fn: () => void): void {
  persistFn = fn
}

/** Persist the current in-memory local settings to disk, if a writer is registered. */
export function persistSettings(): void {
  persistFn?.()
}

/**
 * Resolve the device a backend should default to. Precedence:
 *   1. an existing persisted per-backend choice for `key` (returned unchanged),
 *   2. the user's wizard-chosen `preferred` device, matched to this backend's
 *      own detected list (GPU by name; CPU where the backend exposes one),
 *   3. the automatic ranking (dedicated GPU > integrated GPU > NPU > CPU).
 * The resolved id is written into `settingsMap` as if the user had selected it
 * and persisted to disk, so it survives restarts and later detection changes.
 */
export async function resolveDefaultDevice(
  devices: { id: string; name: string }[],
  settingsMap: Record<string, string>,
  key: string,
  preferred: PreferredDevice | null | undefined,
): Promise<string | undefined> {
  const persistedId = settingsMap[key]
  if (persistedId !== undefined) return persistedId
  if (devices.length === 0) return undefined

  let chosenId: string | undefined
  let source = 'auto-ranked'

  if (preferred?.kind === 'gpu') {
    chosenId = bestNameMatch(preferred.name, devices)?.id
    if (chosenId !== undefined) source = 'wizard preference'
  } else if (preferred?.kind === 'cpu') {
    // Only backends that enumerate a CPU device (e.g. OpenVINO) can honor a
    // CPU-only preference here; llama.cpp / ComfyUI list GPUs only and fall
    // through to the automatic ranking.
    chosenId = devices.find(
      (d) => d.id.toUpperCase() === 'CPU' || d.name.toUpperCase() === 'CPU',
    )?.id
    if (chosenId !== undefined) source = 'wizard preference (CPU)'
  }

  if (chosenId === undefined) {
    chosenId = await pickBestDeviceId(devices)
  }

  if (chosenId !== undefined) {
    settingsMap[key] = chosenId
    persistSettings()
    appLogger.info(
      `Selected default device '${chosenId}' for '${key}' (${source}, no prior selection)`,
      'electron-backend',
    )
  }
  return chosenId
}
