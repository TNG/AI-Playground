import fs from 'node:fs'
import path from 'node:path'

/**
 * Reads the machine-wide install configuration written by the all-users
 * installer and, in "shared" model-folder mode, makes the per-user resources
 * `models` directory a junction to the machine-wide shared folder.
 *
 * The installer writes a small JSON file to a machine-readable location
 * (`%ProgramData%/AI Playground/install-config.json` on Windows). A per-user
 * install writes no such file, so the app keeps its own per-user models
 * directory — i.e. this whole module is a no-op unless an admin chose an
 * all-users install with a shared model folder.
 *
 * Why a junction rather than rewriting `model_config.json`: the download
 * target, model scanning (PathsManager) and every backend
 * (llama.cpp/OpenVINO/ComfyUI) independently resolve models under
 * `<resourcesRoot>/models`. Pointing that single directory at the shared folder
 * redirects all of them at once; rewriting `model_config.json` would only move
 * the download/scan side and leave the backends looking in the per-user root.
 */

export type ModelFolderMode = 'shared' | 'per-user'

export interface InstallConfig {
  modelFolderMode: ModelFolderMode
  /** Absolute path to the shared `models` directory (only in "shared" mode). */
  sharedModelDir?: string
}

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
 * On an all-users install with a shared model folder, make
 * `<resourcesRoot>/models` a junction to the machine-wide shared folder so
 * downloads, scanning and all backends transparently use the shared location.
 *
 * Idempotent and best-effort: on any failure (or a per-user install) the app
 * simply keeps its own per-user models directory. Must run after the resources
 * root has been seeded and before models are accessed.
 */
export function ensureSharedModelsDir(resourcesRoot: string): void {
  const cfg = readInstallConfig()
  if (!cfg || cfg.modelFolderMode !== 'shared') return

  // The installer normally records only the mode; derive the default location
  // unless an explicit path was provided (e.g. an admin pointing at a share).
  const sharedDir = cfg.sharedModelDir || defaultSharedModelDir()
  const modelsPath = path.join(resourcesRoot, 'models')

  // Ensure the shared target exists. If it's read-only for this user the link
  // still works for reads; downloads are disabled elsewhere in that case.
  try {
    fs.mkdirSync(sharedDir, { recursive: true })
  } catch {
    // ignore — try to link anyway
  }

  try {
    const stat = fs.lstatSync(modelsPath)
    if (stat.isSymbolicLink()) return // already linked
    if (stat.isDirectory()) {
      // Only replace a real directory when empty, so locally-downloaded models
      // are never discarded. (Fresh installs have no bundled `models` dir.)
      if (fs.readdirSync(modelsPath).length > 0) return
      fs.rmdirSync(modelsPath)
    }
  } catch {
    // modelsPath doesn't exist yet — fall through and create the junction.
  }

  try {
    // 'junction' works unelevated for a local target (Windows); on other
    // platforms Node falls back to a normal symlink.
    fs.symlinkSync(sharedDir, modelsPath, 'junction')
  } catch (e) {
    console.error('[installConfig] failed to link shared models dir:', e)
  }
}
