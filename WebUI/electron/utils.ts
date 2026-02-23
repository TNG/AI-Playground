import koffi from 'koffi'
import { app } from 'electron'
import fs from 'fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Determines whether the current user has administrator privileges on Windows.
 *
 * @returns `true` if running on Windows and the current user is an administrator, `false` otherwise.
 */
export function isAdmin(): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  const lib = koffi.load('Shell32.dll')
  try {
    const IsUserAnAdmin = lib.func('IsUserAnAdmin', 'bool', [])
    return IsUserAnAdmin()
  } finally {
    lib.unload()
  }
}

/**
 * Determines whether creating a file under the given external resources directory requires administrator privileges.
 *
 * @param externalRes - Absolute path to the external resources directory to probe
 * @returns `true` if creating a temporary file at `externalRes` appears to require admin privileges, `false` otherwise
 */
export function needAdminPermission(externalRes: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const filename = path.join(externalRes, `${randomUUID()}.txt`)
    fs.writeFile(filename, '', (err) => {
      if (err) {
        if (err && err.code == 'EPERM') {
          if (path.parse(externalRes).root == path.parse(process.env.windir!).root) {
            resolve(!isAdmin())
          } else {
            resolve(false)
          }
        } else {
          resolve(false)
        }
      } else {
        fs.rmSync(filename)
        resolve(false)
      }
    })
  })
}

/**
 * Resolve the absolute path to the application's external resources directory.
 *
 * When the app is packaged this returns the packaged resources path; otherwise it returns the local `external/` directory relative to this module.
 *
 * @returns The absolute filesystem path to the external resources directory
 */
export function externalResourcesDir(): string {
  return path.resolve(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../external/'),
  )
}

/**
 * Get the filesystem path to the media subdirectory of the external resources directory.
 *
 * @returns The absolute path to the `media` directory located inside the external resources directory
 */
export function getMediaDir(): string {
  return path.join(externalResourcesDir(), 'media')
}

/**
 * Resolve a remote or aipg-media URL to a local file path under the media directory.
 *
 * Handles `aipg-media://` URIs by decoding the scheme and joining the result with `mediaDir`.
 * For HTTP(S) URLs, parses the URL and:
 * - If `comfyBackendUrl` is provided and the URL includes it, uses `subfolder` and `filename` query parameters to build the path.
 * - Otherwise uses the URL pathname.
 *
 * @param url - The source URL to resolve (supports `aipg-media://` and HTTP(S) URLs)
 * @param mediaDir - Root local media directory to which the resolved path will be joined
 * @param comfyBackendUrl - Optional base URL of a ComfyUI backend; when present and matched, `subfolder`/`filename` query params are used
 * @returns The local filesystem path under `mediaDir` corresponding to the URL, or `undefined` if the URL could not be parsed
 */
export function getAssetPathFromUrl(
  url: string,
  mediaDir: string,
  comfyBackendUrl?: string,
): string | undefined {
  const resolvedMediaDir = path.resolve(mediaDir)

  /** Returns resolvedPath only when it is strictly inside resolvedMediaDir. */
  function guardTraversal(resolvedPath: string): string | undefined {
    const relative = path.relative(resolvedMediaDir, resolvedPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      console.error('Path traversal attempt blocked', { resolvedPath, resolvedMediaDir })
      return undefined
    }
    return resolvedPath
  }

  // Handle aipg-media:// URLs
  if (url.startsWith('aipg-media://')) {
    const decodedUrl = decodeURIComponent(url.replace(/^aipg-media:\/\//i, ''))
    return guardTraversal(path.resolve(resolvedMediaDir, decodedUrl))
  }

  // Existing logic for HTTP URLs
  const imageUrl = URL.parse(url)
  if (!imageUrl) {
    console.error('Could not find image for URL', { url })
    return
  }

  const backend = comfyBackendUrl && url.includes(comfyBackendUrl) ? 'comfyui' : 'service'

  const imageSubPath =
    backend === 'comfyui'
      ? path.join(
          imageUrl.searchParams.get('subfolder') ?? '',
          imageUrl.searchParams.get('filename') ?? '',
        )
      : imageUrl.pathname
  return guardTraversal(path.resolve(resolvedMediaDir, imageSubPath))
}
