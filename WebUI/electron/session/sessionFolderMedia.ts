import fs from 'node:fs'
import path from 'node:path'
import { isSessionId, readSessionFileSync, sessionFolderPaths } from '../persist/sessionFiles'
import { artifactFoldersOf, sessionFolderListOf } from './sessionFolderList'
import { sessionMediaPathOf } from '@/lib/comfyWorkflow'

function inside(base: string, relativePath: string): string | null {
  const root = path.resolve(base)
  const full = path.resolve(root, relativePath)
  const relative = path.relative(root, full)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return full
}

/**
 * The file an `aipg-media://folders/<session>/<folder>/<path>` URL names: only inside a folder
 * that Session lists or once listed, never outside it; null for anything else.
 */
export function sessionFolderMediaFile(url: string): string | null {
  const target = sessionMediaPathOf(url.replace(/[/\\]+$/, ''))
  if (!target?.folderId || !isSessionId(target.sessionId)) return null
  const file = readSessionFileSync(target.sessionId)
  if (!file) return null
  const entry = artifactFoldersOf(sessionFolderListOf(file)).find(
    (folder) => folder.id === target.folderId,
  )
  if (!entry || entry.planned) return null
  return inside(entry.hostPath, target.path)
}

/**
 * The file an older `aipg-media://sessions/<session>/files/<path>` URL names: in `files/` while
 * it is still there, else in the folder entry the migration moved `files/` to.
 */
export function sessionLegacyMediaFile(url: string): string | null {
  const target = sessionMediaPathOf(url.replace(/[/\\]+$/, ''))
  if (!target || target.folderId || !isSessionId(target.sessionId)) return null
  const { filesDir, artifactRoot } = sessionFolderPaths(target.sessionId)
  const old = inside(artifactRoot, target.path)
  if (!old) return null
  if (!inside(filesDir, old)) return null
  const relative = path.relative(path.resolve(filesDir), old)
  if (fs.existsSync(old)) return old
  const file = readSessionFileSync(target.sessionId)
  const entry = file
    ? artifactFoldersOf(sessionFolderListOf(file)).find(
        (folder) => folder.id === file.legacyFilesFolderId,
      )
    : undefined
  if (!entry || entry.planned) return old
  return inside(entry.hostPath, relative)
}
