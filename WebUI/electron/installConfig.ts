import fs from 'node:fs'
import path from 'node:path'

/**
 * Reads the machine-wide install configuration written by the all-users
 * installer, and (in "shared" model-folder mode) re-roots the per-user
 * `model_config.json` so every model path points at the shared directory
 * instead of the per-user resources root.
 *
 * The installer writes a small JSON file to a machine-readable location
 * (`%ProgramData%/AI Playground/install-config.json` on Windows). A per-user
 * install writes no such file, so the app keeps its default per-user paths —
 * i.e. this whole module is a no-op unless an admin chose an all-users install
 * with a shared model folder.
 */

export type ModelFolderMode = 'shared' | 'per-user'

export interface InstallConfig {
  modelFolderMode: ModelFolderMode
  /** Absolute path to the shared `models` directory (only in "shared" mode). */
  sharedModelDir?: string
}

/** All model paths in `model_config.json` are relative to this prefix. */
const MODELS_PREFIX = './resources/models/'

/** `%ProgramData%` (or a sensible fallback) — machine-wide, world-readable. */
function programDataDir(): string {
  return process.env.ProgramData?.trim() || 'C:\\ProgramData'
}

/** Location of the machine-wide install config written by the installer. */
function installConfigPath(): string {
  if (process.platform === 'win32') {
    return path.join(programDataDir(), 'AI Playground', 'install-config.json')
  }
  // No all-users installer flow on non-Windows yet; keep a conventional path so
  // the reader is platform-safe.
  return '/etc/ai-playground/install-config.json'
}

/**
 * Default shared `models` directory when the installer recorded "shared" mode
 * without an explicit path. Kept in sync with the installer, which creates
 * `%ProgramData%/AI Playground/models`.
 */
function defaultSharedModelDir(): string {
  return path.join(programDataDir(), 'AI Playground', 'models')
}

export function readInstallConfig(): InstallConfig | null {
  try {
    const raw = fs.readFileSync(installConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<InstallConfig>
    if (parsed.modelFolderMode !== 'shared' && parsed.modelFolderMode !== 'per-user') {
      return null
    }
    return {
      modelFolderMode: parsed.modelFolderMode,
      sharedModelDir: parsed.sharedModelDir?.trim() || undefined,
    }
  } catch {
    return null
  }
}

/**
 * On an all-users install with a shared model folder, rewrite the freshly
 * seeded `model_config.json` so each `./resources/models/...` path becomes an
 * absolute path under the shared directory. Runs once per user (guarded by a
 * marker next to the config); afterwards the user's own path edits win.
 *
 * Must be called BEFORE `PathsManager` reads the config.
 */
export function applySharedModelPaths(modelConfigPath: string): void {
  const cfg = readInstallConfig()
  if (!cfg || cfg.modelFolderMode !== 'shared') return

  // The installer normally records only the mode; derive the default location
  // unless an explicit path was provided (e.g. an admin pointing at a share).
  const sharedDir = cfg.sharedModelDir || defaultSharedModelDir()

  const marker = path.join(path.dirname(modelConfigPath), '.aipg-shared-models-seeded')
  if (fs.existsSync(marker)) return

  try {
    const raw = JSON.parse(fs.readFileSync(modelConfigPath, 'utf-8')) as Record<string, string>
    const rewritten: Record<string, string> = {}
    for (const [key, value] of Object.entries(raw)) {
      const normalized = value.replace(/\\/g, '/')
      rewritten[key] = normalized.startsWith(MODELS_PREFIX)
        ? path.join(sharedDir, normalized.slice(MODELS_PREFIX.length))
        : value
    }
    fs.writeFileSync(modelConfigPath, JSON.stringify(rewritten, null, 4))
    fs.writeFileSync(marker, sharedDir)
  } catch {
    // Best effort: on any failure the app falls back to per-user default paths.
  }
}
