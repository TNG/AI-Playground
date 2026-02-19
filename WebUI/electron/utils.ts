import koffi from 'koffi'
import { app } from 'electron'
import fs from 'fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

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

export function needAdminPermission(externalRes: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const filename = path.join(externalRes, `${randomUUID()}.txt`)
    fs.writeFile(filename, '', (err) => {
      if (err) {
        if (err && err.code == 'EPERM') {
          if (path.parse(externalRes).root == path.parse(process.env.windir!).root) {
            resolve(!isAdmin())
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

export function externalResourcesDir(): string {
  return path.resolve(
    app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../external/'),
  )
}

export function getMediaDir(): string {
  return path.join(externalResourcesDir(), 'media')
}

export function getAssetPathFromUrl(
  url: string,
  mediaDir: string,
  comfyBackendUrl?: string,
): string | undefined {
  // Handle aipg-media:// URLs
  if (url.startsWith('aipg-media://')) {
    const decodedUrl = decodeURIComponent(url.replace(/^aipg-media:\/\//i, ''))
    return path.join(mediaDir, decodedUrl)
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
  return path.join(mediaDir, imageSubPath)
}
