import { app } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { installConfigAppliesTo, readInstallConfig } from './installConfig.ts'
import { grantUsersModifySync } from './sharedAcl.ts'

/**
 * Resolves the packaged "resources root" — the directory the app treats as both
 * its bundled resources AND its writable working tree (Python interpreter,
 * backend venvs, LlamaCPP/ComfyUI installs, preset edits, settings, logs).
 *
 * The install directory is used directly when it is writable — the default for
 * a per-user Windows install and for dev — so this is simply
 * `process.resourcesPath` (unchanged behaviour).
 *
 * When the install directory is **not** writable we relocate the root to a
 * per-user writable directory and seed it from the read-only bundle once per
 * build: a stale marker means the app was updated, so the shipped trees are
 * copied again and presets the new build no longer ships are pruned from the
 * shipped preset tree. Two cases hit this path:
 *   - Linux: the app ships as a read-only bundle (AppImage squashfs mount, or a
 *     `/opt` install owned by root), so writes fail with EROFS/ENOENT.
 *   - Windows all-users install: the app lives under `Program Files` and a
 *     standard (unelevated) user cannot write there.
 * Runtime data created later (venvs, models, `python-interpreter/`, …) is never
 * part of the bundle, so it is preserved across re-seeds.
 *
 * **Shared all-users install** (HKLM `modelFolderMode` = `shared`): the resources
 * root points at `<sharedResourcesDir>/resources`. The installer grants
 * inheritable Modify to BUILTIN\Users, and shared installs copy uv packages into
 * that tree so new files inherit the grant. The heavy artifacts are provisioned
 * there once and maintained by every account. Each user's *mutable* config
 * (settings, logs, model_config, mcp, embeddingCache, ComfyUI scratch) is kept
 * private via `writableConfigRoot()` so users do not clobber each other. See
 * `userConfig.ts`.
 */

/**
 * Whether this is a Windows all-users install configured to share the heavy
 * runtime artifacts across users. Cached — the install config never changes
 * while the app is running.
 */
let sharedMode: boolean | undefined
const sharedModeActive = (): boolean => {
  if (sharedMode !== undefined) return sharedMode
  const config = process.platform === 'win32' ? readInstallConfig() : null
  sharedMode = false
  if (config?.modelFolderMode === 'shared') {
    const installDir = path.dirname(process.resourcesPath)
    sharedMode = installConfigAppliesTo(config, installDir, isInstallDirWritable)
    if (!sharedMode) {
      console.error(`[aipgRoot] machine install config belongs to another install: ${installDir}`)
    }
  }
  return sharedMode
}

export function isSharedAllUsersInstall(): boolean {
  return sharedModeActive()
}

/**
 * Per-user writable root. No spaces in the path — Python venvs dislike them.
 * `%LOCALAPPDATA%/ai-playground/resources` on Windows,
 * `$XDG_DATA_HOME/ai-playground/resources` (or `~/.local/share/...`) elsewhere.
 */
const writableUserRoot = (): string => {
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'ai-playground', 'resources')
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
  return path.join(dataHome, 'ai-playground', 'resources')
}

/**
 * Machine-wide shared resources root. The base directory is the validated
 * admin-chosen path from HKLM (`installConfig.ts`). The `resources` leaf is
 * always appended so relative model paths in `model_config.json`
 * (`./resources/models/...`), anchored to `path.dirname(root)`, resolve to
 * `<base>/resources/models`, exactly mirroring the per-user layout. Without a
 * validated base this falls back to the per-user writable root.
 */
const sharedInstallRoot = (): string => {
  const base = sharedModeActive() ? readInstallConfig()?.sharedResourcesDir?.trim() : undefined
  if (!base) return writableUserRoot()
  return path.join(base, 'resources')
}

/**
 * Whether `process.resourcesPath` is writable by the current user. Per-user
 * Windows installs and dev checkouts are writable; a read-only Linux bundle and
 * an all-users `Program Files` install run unelevated are not. Electron ships
 * with UAC file/registry virtualization disabled, so a failed write to
 * `Program Files` surfaces as an error here instead of being silently
 * redirected to a VirtualStore. Probed once and cached.
 */
let installDirWritable: boolean | undefined
const isInstallDirWritable = (): boolean => {
  if (installDirWritable !== undefined) return installDirWritable
  const probe = path.join(process.resourcesPath, `.aipg-write-probe-${process.pid}`)
  try {
    fs.writeFileSync(probe, '')
    fs.rmSync(probe, { force: true })
    installDirWritable = true
  } catch {
    installDirWritable = false
  }
  return installDirWritable
}

// Binaries that must keep their executable bit after being copied out of the
// read-only bundle (filenames are kept as `*.exe` on all platforms by the
// fetch-external-resources script for naming consistency).
const EXECUTABLE_RESOURCE_FILES = ['uv.exe', 'uvw.exe', 'uvx.exe', '7zr.exe']

const SEED_SCHEMA = 2

/**
 * The build's short commit, falling back to its release tag. Both are baked
 * into every bundle by `vite.config.mts`; the same values name installers.
 */
function buildIdentity(): string {
  return (
    (import.meta.env.VITE_GIT_COMMIT ?? '').trim() || (import.meta.env.VITE_GIT_TAG ?? '').trim()
  )
}

/** Freshness marker for the writable root; the `2|` prefix forces a re-seed on a format change. */
export function seedId(
  version: string = app.getVersion(),
  build: string = buildIdentity(),
): string {
  return `${SEED_SCHEMA}|${version}|${build}`
}

let warnedEmptyBuild = false

const isInsideTree = (treeReal: string, candidate: string): boolean => {
  const rel = path.relative(treeReal, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/** Every relative path in the bundle's copy of the preset tree. */
function bundleTreePaths(treeDir: string): Set<string> {
  const paths = new Set<string>()
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name)
      paths.add(path.relative(treeDir, abs))
      if (entry.isDirectory()) visit(abs)
    }
  }
  visit(treeDir)
  return paths
}

/**
 * Removes presets the new build dropped from the writable `modes` tree. Best
 * effort: a failure warns and leaves the tree usable, and links are never followed.
 */
function pruneDroppedPresets(root: string, bundle: string): number {
  const tree = path.join(root, 'modes')
  const bundleTree = path.join(bundle, 'modes')
  let removed = 0

  try {
    const treeStat = fs.lstatSync(tree, { throwIfNoEntry: false })
    const bundleStat = fs.lstatSync(bundleTree, { throwIfNoEntry: false })
    if (!treeStat?.isDirectory() || !bundleStat?.isDirectory()) return 0

    const treeReal = fs.realpathSync(tree)
    const bundleReal = fs.realpathSync(bundleTree)
    if (treeReal === bundleReal) return 0

    const bundlePaths = bundleTreePaths(bundleReal)

    const removeIfInside = (target: string, remove: () => void): void => {
      if (!isInsideTree(treeReal, target)) {
        console.warn(`[aipgRoot] refusing to remove a path outside the preset tree: ${target}`)
        return
      }
      try {
        remove()
        removed++
      } catch (e) {
        console.warn(`[aipgRoot] could not remove ${target}:`, e)
      }
    }

    const visit = (dir: string): void => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch (e) {
        console.warn(`[aipgRoot] could not read ${dir} while pruning the preset tree:`, e)
        return
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name)
        const rel = path.relative(treeReal, abs)
        try {
          const stat = fs.lstatSync(abs, { throwIfNoEntry: false })
          if (!stat) continue

          if (stat.isSymbolicLink()) {
            console.warn(`[aipgRoot] leaving a link in the preset tree in place: ${abs}`)
          } else if (stat.isDirectory()) {
            const real = fs.realpathSync(abs)
            if (!isInsideTree(treeReal, real)) {
              console.warn(
                `[aipgRoot] leaving a directory outside the preset tree in place: ${abs}`,
              )
              continue
            }
            visit(abs)
            if (!bundlePaths.has(rel) && fs.readdirSync(abs).length === 0) {
              removeIfInside(abs, () => fs.rmdirSync(abs))
            }
          } else if (stat.isFile()) {
            if (!bundlePaths.has(rel)) removeIfInside(abs, () => fs.unlinkSync(abs))
          } else {
            console.warn(`[aipgRoot] leaving a special file in the preset tree in place: ${abs}`)
          }
        } catch (e) {
          console.warn(`[aipgRoot] skipping ${abs} while pruning the preset tree:`, e)
        }
      }
    }

    visit(treeReal)
  } catch (e) {
    console.warn('[aipgRoot] failed to prune the shipped preset tree:', e)
  }
  return removed
}

let seeded = false

function copyBundledExecutables(root: string, bundle: string): void {
  for (const name of EXECUTABLE_RESOURCE_FILES) {
    const source = path.join(bundle, name)
    const target = path.join(root, name)
    try {
      if (!fs.existsSync(source)) continue
      fs.copyFileSync(source, target)
      fs.chmodSync(target, 0o755)
    } catch {
      // best effort — a locked file is replaced on the next launch
    }
  }
}

function seedWritableRoot(root: string): void {
  const bundle = process.resourcesPath
  const markerPath = path.join(root, '.aipg-seed-version')
  const currentId = seedId()

  if (!buildIdentity() && !warnedEmptyBuild) {
    warnedEmptyBuild = true
    console.warn(
      '[aipgRoot] build has no commit or tag; a rebuild at the same version will not refresh shipped files',
    )
  }

  let previousId = ''
  try {
    previousId = fs.readFileSync(markerPath, 'utf-8').trim()
  } catch {}
  // The marker lives in the writable tree, so a matching identity must not skip
  // the shipped binaries: those are the files the backends spawn.
  if (previousId === currentId) {
    copyBundledExecutables(root, bundle)
    return
  }

  fs.mkdirSync(root, { recursive: true })
  // Grant before the copy so new files inherit Modify. Runtime environments must
  // not be cloned out of Program Files: a copied .venv still looks installed.
  if (sharedModeActive()) grantUsersModifySync(root)

  // Copy the bundled (shipped) files over the writable root. `force: true`
  // refreshes shipped files on app update; runtime-created directories that are
  // not part of the bundle are left untouched because cpSync only walks `bundle`.
  // Skip the packed Electron app itself (`app.asar`, `app.asar.unpacked`) — it is
  // not part of the backend working tree and would needlessly bloat the copy.
  fs.cpSync(bundle, root, {
    recursive: true,
    force: true,
    filter: (src) => {
      const name = path.basename(src)
      return (
        name !== 'app.asar' &&
        name !== 'app.asar.unpacked' &&
        name !== '.venv' &&
        name !== 'python-interpreter'
      )
    },
  })
  if (sharedModeActive()) grantUsersModifySync(root)

  // cpSync does not reliably preserve the executable bit, and a file already in
  // the tree must not win over the copy shipped in the install directory.
  copyBundledExecutables(root, bundle)

  const removed = pruneDroppedPresets(root, bundle)

  fs.writeFileSync(markerPath, currentId, 'utf-8')
  console.info(
    `[aipgRoot] re-seeded shipped resources ${previousId || '(none)'} -> ${currentId}; removed ${removed} entries`,
  )
}

/**
 * The packaged resources root. When the install directory is writable this is
 * `process.resourcesPath`; otherwise it is a per-user writable directory
 * (seeded from the read-only bundle on first use). Safe to call before `app` is
 * ready.
 *
 * Only meaningful when `app.isPackaged` is true; callers keep their own
 * development-mode paths for the unpackaged case.
 */
export function packagedResourcesRoot(): string {
  if (!app.isPackaged) return process.resourcesPath

  // Shared all-users install: use the machine-wide root and seed it once from
  // the read-only bundle. The installer grants every account inheritable write
  // access, and seeding re-applies it, so the first user provisions the tree
  // (bundle + venvs + backends + models) and later users can replace a broken
  // environment. A stale seed marker after an app update triggers a reseed.
  const root = sharedModeActive() ? sharedInstallRoot() : writableUserRoot()

  if (sharedModeActive() || !isInstallDirWritable()) {
    if (!seeded) {
      try {
        seedWritableRoot(root)
      } catch (e) {
        // Logger may not exist this early; fall back to console so the failure is
        // visible without crashing startup.
        console.error('[aipgRoot] failed to seed resources dir:', e)
      }
      seeded = true
    }
    return root
  }

  // Writable install dir (per-user Windows install, dev): use it directly.
  return process.resourcesPath
}

/**
 * Root for this user's *mutable* config — settings, logs, model_config, mcp,
 * embeddingCache and ComfyUI scratch. In a shared all-users install this is a
 * private per-user directory so users never overwrite each other's config; in
 * every other mode it equals `packagedResourcesRoot()`, keeping current
 * behaviour unchanged. Callers seed individual files from the shared defaults on
 * first use (see `userConfig.ts`).
 */
export function writableConfigRoot(): string {
  if (app.isPackaged && sharedModeActive()) {
    const localAppData =
      process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(localAppData, 'ai-playground', 'config')
  }
  return packagedResourcesRoot()
}

/**
 * The shipped `external/` tree (models.json, presets, backend versions). In a
 * packaged app it is the resources root; unpackaged it is resolved against the
 * bundle output directory, not this source file.
 */
export const externalResourcesDir = () =>
  path.resolve(app.isPackaged ? packagedResourcesRoot() : path.join(__dirname, '../../external/'))
