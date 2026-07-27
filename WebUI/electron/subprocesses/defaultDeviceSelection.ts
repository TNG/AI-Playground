import { pickBestDeviceId } from './hardwareDiscovery.ts'
import { appLoggerInstance as appLogger } from '../logging/logger.ts'

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
 * Resolve the device a backend should default to. When the user already has a
 * persisted choice for `key` it is returned unchanged. Otherwise the best device
 * (dedicated GPU > integrated GPU > NPU > CPU) is chosen from the backend's own
 * detected list, written into `settingsMap` as if the user had selected it, and
 * persisted to disk so it survives restarts and later detection changes.
 */
export async function resolveDefaultDevice(
  devices: { id: string; name: string }[],
  settingsMap: Record<string, string>,
  key: string,
): Promise<string | undefined> {
  const persistedId = settingsMap[key]
  if (persistedId !== undefined) return persistedId

  const bestId = await pickBestDeviceId(devices)
  if (bestId !== undefined) {
    settingsMap[key] = bestId
    persistSettings()
    appLogger.info(
      `Auto-selected default device '${bestId}' for '${key}' (no prior selection)`,
      'electron-backend',
    )
  }
  return bestId
}
