import fs from 'node:fs'
import path from 'node:path'

/**
 * Reads the machine-wide install configuration written by the all-users
 * installer. It records a single choice: whether the heavy runtime artifacts
 * (Python interpreter, backend venvs, backend installs and models — tens of GB)
 * are shared across all users of the machine or kept per-user.
 *
 * The installer writes a small JSON file to a machine-readable location
 * (`%ProgramData%/AI Playground/install-config.json` on Windows). A per-user
 * install writes no such file, so `readInstallConfig()` returns null and the app
 * keeps its default per-user paths.
 *
 * In "shared" mode `aipgRoot.ts` points the resources root at
 * `%ProgramData%/AI Playground/resources` (read/write for all users via an ACL
 * the installer grants) and relocates each user's mutable config to a private
 * per-user folder. See `aipgRoot.ts` and `userConfig.ts`.
 */

export type ModelFolderMode = 'shared' | 'per-user'

export interface InstallConfig {
  modelFolderMode: ModelFolderMode
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

export function readInstallConfig(): InstallConfig | null {
  try {
    const raw = fs.readFileSync(installConfigPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<InstallConfig>
    if (parsed.modelFolderMode !== 'shared' && parsed.modelFolderMode !== 'per-user') {
      return null
    }
    return { modelFolderMode: parsed.modelFolderMode }
  } catch {
    return null
  }
}
