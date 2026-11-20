import fs from 'node:fs/promises'
import path from 'node:path'
import { appWorkspacesRoot, sessionFolderPaths } from '../persist/sessionFiles'
import { sessionFolderListOf } from './sessionFolderList'
import type { SessionFile } from '@/types/sessionIpc'

// What deleting a Session takes with it: the app-created Workspaces still on its list.

/** Whether `hostPath` is a folder the app makes Workspaces in: the Workspaces root, or own `files/`. */
function madeByTheApp(sessionId: string, hostPath: string): boolean {
  const dir = path.resolve(hostPath)
  if (path.dirname(dir) === path.resolve(appWorkspacesRoot())) return true
  return dir === path.resolve(sessionFolderPaths(sessionId).filesDir)
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.lstat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** Listed, app-created, on disk, and inside a folder the app makes Workspaces in. */
export async function ownedWorkspaceDirs(file: SessionFile): Promise<string[]> {
  const candidates = sessionFolderListOf(file)
    .folders.filter((folder) => folder.appCreated && !folder.planned)
    .map((folder) => folder.hostPath)
    .filter((hostPath) => madeByTheApp(file.id, hostPath))
  const present = await Promise.all(candidates.map(isDirectory))
  return candidates.filter((_dir, index) => present[index])
}

export async function countFiles(dir: string): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true })
  return entries.filter((entry) => entry.isFile()).length
}
