import path from 'path'

/** Projects whose wheels ship in an offline-installer uv cache. */
export const OFFLINE_UV_PROJECTS = ['service', 'home-agent', 'OpenVINO'] as const

export const OFFLINE_PYTHON_VERSION = '3.12'

/** Marker file inside `uv-cache`. Its presence means these projects must not hit the network. */
export const OFFLINE_UV_MARKER = '.aipg-offline'

export function offlineUvCacheDir(baseDir: string): string {
  return path.join(baseDir, 'uv-cache')
}

export function offlineUvMarkerPath(baseDir: string): string {
  return path.join(offlineUvCacheDir(baseDir), OFFLINE_UV_MARKER)
}

/**
 * Prepend `--offline` and point UV_CACHE_DIR at the bundled cache when this
 * project is one of the offline-installer projects and the marker is present.
 * Other projects keep the normal online uv behavior.
 */
export function applyOfflineUv(
  command: string[],
  options: {
    baseDir: string
    project?: string
    markerExists: boolean
    extraEnv?: Record<string, string>
  },
): { command: string[]; env?: Record<string, string> } {
  const covered =
    options.project !== undefined &&
    (OFFLINE_UV_PROJECTS as readonly string[]).includes(options.project)
  if (!options.markerExists || !covered) {
    return { command, env: options.extraEnv }
  }
  const next = command[0] === '--offline' ? command : ['--offline', ...command]
  return {
    command: next,
    env: { ...options.extraEnv, UV_CACHE_DIR: offlineUvCacheDir(options.baseDir) },
  }
}
