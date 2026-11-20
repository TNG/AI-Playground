import fs from 'node:fs/promises'
import path from 'node:path'
import { countFiles, entriesOf, mergeInto, removeEmptyFolder } from './fileOps'
import { SESSION_ATTACHMENTS_DIR, sessionArtifactsRoot, sessionFolderPaths } from './sessionFiles'

// An older Session's `AI-Playground/sessions/<id>/files/`, on its way to the ADR 0013 layout.

function legacyAttachmentsDir(id: string): string {
  return path.join(sessionFolderPaths(id).filesDir, SESSION_ATTACHMENTS_DIR)
}

/** Moves the attachments left in `files/attachments` into internal storage; how many moved. */
export async function moveLegacyAttachments(id: string): Promise<number> {
  return mergeInto(legacyAttachmentsDir(id), sessionFolderPaths(id).attachmentsDir)
}

export type LegacyFiles = {
  hasFiles: boolean
  /** Attachments that have not left `files/` yet; it must not move before they have. */
  attachmentsLeft: boolean
  /** What `files/` holds at its top level. */
  topNames: string[]
}

export async function legacyFilesOf(id: string): Promise<LegacyFiles> {
  const { filesDir } = sessionFolderPaths(id)
  const attachments = await entriesOf(legacyAttachmentsDir(id))
  return {
    hasFiles: (await countFiles(filesDir)) > 0,
    attachmentsLeft: attachments.some((entry) => !entry.isDirectory()),
    topNames: (await entriesOf(filesDir)).map((entry) => entry.name),
  }
}

/** Moves the contents of `files/` into `dir`, keeping what already arrived. */
export async function moveLegacyFilesInto(id: string, dir: string): Promise<void> {
  await mergeInto(sessionFolderPaths(id).filesDir, dir)
}

/** Removes an emptied `files/`, and the Session's folder around it when nothing else is left. */
export async function removeLegacyFilesFolder(id: string): Promise<void> {
  const { filesDir, artifactRoot } = sessionFolderPaths(id)
  if ((await countFiles(filesDir)) === 0) await fs.rm(filesDir, { recursive: true, force: true })
  await removeEmptyFolder(artifactRoot)
}

/** Removes `AI-Playground/sessions/` once every older Session has left it. */
export async function removeLegacySessionsRoot(): Promise<void> {
  await removeEmptyFolder(sessionArtifactsRoot())
}
