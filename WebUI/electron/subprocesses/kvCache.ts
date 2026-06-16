import path from 'node:path'
import * as filesystem from 'fs-extra'
import { app } from 'electron'

/**
 * On-disk store for llama-server KV cache slot dumps. llama-server writes/reads
 * these files itself when we call its `/slots/{id}?action=save|restore`
 * endpoints, with the directory fixed at launch via `--slot-save-path`.
 *
 * Filenames are produced in the renderer with the scheme
 *   kv__<kind>__<convKey>__<modelHash>.bin
 * The `<kind>` segment (main | homeAgent) lets us enforce "keep only the latest
 * cache per kind", and `<modelHash>` keeps a dump from ever being restored into
 * a slot running a different model (llama-server would reject a mismatched
 * header anyway, but the name scoping means we never even try).
 */

const KV_CACHE_DIRNAME = 'llama-kv-cache'

export function getKvCacheDir(): string {
  return path.join(app.getPath('userData'), KV_CACHE_DIRNAME)
}

export async function ensureKvCacheDir(): Promise<string> {
  const dir = getKvCacheDir()
  await filesystem.ensureDir(dir)
  return dir
}

/**
 * Reject anything that isn't a bare `kv__….bin` basename so a renderer-supplied
 * string can never escape the cache dir (path traversal) or address an
 * unrelated file.
 */
function isSafeCacheFilename(filename: string): boolean {
  if (typeof filename !== 'string' || filename.length === 0) return false
  if (filename !== path.basename(filename)) return false
  if (filename.includes('..')) return false
  return filename.startsWith('kv__') && filename.endsWith('.bin')
}

function kindOf(filename: string): string | undefined {
  // kv__<kind>__<convKey>__<modelHash>.bin
  const parts = filename.split('__')
  return parts.length >= 4 ? parts[1] : undefined
}

/**
 * Reserved `<kind>` for dumps written at the server-restart boundary (e.g. llama
 * is torn down to free VRAM for image generation, then brought back). These
 * survive the process restart so the next prompt — including Home Agent traffic
 * that never touches the renderer's per-conversation save/restore — can reuse
 * the warm KV instead of reprocessing from scratch. Kept in their own kind so
 * `pruneKvCacheToLatest`/`deleteKvCacheForConversation` never sweep them.
 */
const RESTART_KIND = 'restart'

/** djb2 — mirrors the renderer's `hashModelId` so naming stays consistent. */
function hashModelId(model: string): string {
  let h = 5381
  for (let i = 0; i < model.length; i++) {
    h = ((h << 5) + h + model.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}

/** Filename for a single slot's restart snapshot, scoped to the model. */
export function buildRestartKvFilename(slotId: number, model: string): string {
  return `kv__${RESTART_KIND}__slot${slotId}__${hashModelId(model)}.bin`
}

/** Remove a single dump by basename (used to drop empty/consumed snapshots). */
export async function deleteKvCacheFile(filename: string): Promise<void> {
  if (!isSafeCacheFilename(filename)) return
  await filesystem.remove(path.join(getKvCacheDir(), filename)).catch(() => {})
}

/** Drop every restart-kind dump (called once a restore has been attempted). */
export async function clearRestartKvDumps(): Promise<void> {
  const dir = getKvCacheDir()
  if (!(await filesystem.pathExists(dir))) return
  const entries = await filesystem.readdir(dir)
  for (const name of entries) {
    if (!isSafeCacheFilename(name)) continue
    if (kindOf(name) !== RESTART_KIND) continue
    await filesystem.remove(path.join(dir, name)).catch(() => {})
  }
}

export async function kvCacheExists(filename: string): Promise<boolean> {
  if (!isSafeCacheFilename(filename)) return false
  return filesystem.pathExists(path.join(getKvCacheDir(), filename))
}

/**
 * Enforce the retention policy: keep only `keepFilename` for the given kind,
 * delete every other dump of that same kind. Returns the deleted filenames.
 */
export async function pruneKvCacheToLatest(
  kind: string,
  keepFilename: string,
): Promise<string[]> {
  const dir = getKvCacheDir()
  if (!(await filesystem.pathExists(dir))) return []
  const entries = await filesystem.readdir(dir)
  const deleted: string[] = []
  for (const name of entries) {
    if (!isSafeCacheFilename(name)) continue
    if (name === keepFilename) continue
    if (kindOf(name) !== kind) continue
    await filesystem.remove(path.join(dir, name)).catch(() => {})
    deleted.push(name)
  }
  return deleted
}

/**
 * Drop any cache dump belonging to a conversation (called when the thread is
 * deleted). Matches the `__<convKey>__` segment regardless of model hash.
 */
export async function deleteKvCacheForConversation(convKey: string): Promise<void> {
  if (typeof convKey !== 'string' || convKey.length === 0 || convKey.includes('__')) return
  const dir = getKvCacheDir()
  if (!(await filesystem.pathExists(dir))) return
  const entries = await filesystem.readdir(dir)
  const marker = `__${convKey}__`
  for (const name of entries) {
    if (!isSafeCacheFilename(name)) continue
    if (!name.includes(marker)) continue
    await filesystem.remove(path.join(dir, name)).catch(() => {})
  }
}

/** Wipe the whole cache dir (used when the user opts out of the feature). */
export async function clearKvCache(): Promise<void> {
  const dir = getKvCacheDir()
  if (await filesystem.pathExists(dir)) {
    await filesystem.emptyDir(dir).catch(() => {})
  }
}
