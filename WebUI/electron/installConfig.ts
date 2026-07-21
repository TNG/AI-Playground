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

/** Machine-wide config directory the installer writes to. */
function configDir(): string {
  if (process.platform === 'win32') {
    return path.join(programDataDir(), 'AI Playground')
  }
  // No all-users installer flow on non-Windows yet; keep a conventional path so
  // the reader is platform-safe.
  return '/etc/ai-playground'
}

/** Location of the machine-wide install config written by the installer. */
function installConfigPath(): string {
  return path.join(configDir(), 'install-config.json')
}

/**
 * Sidecar written by the installer's directory picker: the admin-chosen shared
 * models folder as a raw path (avoids JSON backslash-escaping in NSIS).
 */
function readSharedModelDirFile(): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(configDir(), 'shared-model-dir.txt'), 'utf-8').trim()
    return raw || undefined
  } catch {
    return undefined
  }
}

/**
 * Default shared `models` directory when neither the install config nor the
 * installer's picker recorded a path. Kept in sync with the installer, which
 * defaults to `%ProgramData%/AI Playground/models`.
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

  // Resolve the shared location, in priority order: an explicit path in
  // install-config.json (manual admin override), the installer's directory
  // picker sidecar, then the default. path.resolve normalises separators so a
  // path written with forward slashes still yields a valid junction target.
  const sharedDir = path.resolve(
    cfg.sharedModelDir || readSharedModelDirFile() || defaultSharedModelDir(),
  )
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
