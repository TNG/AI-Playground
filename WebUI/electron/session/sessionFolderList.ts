import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { appCreatedWorkspaceDir } from './sessionWorkspace'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { assignSlug, resolveMountedFolders } from '@/lib/mountedFolders'
import type { MountedFolder } from '@/types/agentSessionIpc'
import type { SessionFile, SessionFolderEntry, SessionFolderList } from '@/types/sessionIpc'
import { parseSessionSettings } from '@/types/sessionSettings'

// How a `session.json` holds its folder list, including files from before the list existed.

export function newFolderId(): string {
  return `folder-${randomUUID()}`
}

/** The entry for the Workspace the app creates for a Session. */
export function appCreatedWorkspaceEntry(
  sessionId: string,
  takenSlugs: readonly string[],
  id = newFolderId(),
): SessionFolderEntry {
  const hostPath = appCreatedWorkspaceDir(sessionId)
  return {
    id,
    hostPath,
    access: 'read-write',
    slug: assignSlug(hostPath, takenSlugs),
    appCreated: true,
  }
}

/** Mounted Folders the Assistant's Session Settings held before the list belonged to the Session. */
function legacyMountedFolders(file: SessionFile): MountedFolder[] {
  const entry = parseSessionSettings(file.settings)[HARNESS_CHAT_PRESET]
  const keys = Object.keys(entry?.bags ?? {}).sort((a, b) =>
    a === HARNESS_CHAT_PRESET ? 1 : b === HARNESS_CHAT_PRESET ? -1 : 0,
  )
  return keys.flatMap((key) => {
    const folders = entry?.bags[key].values.mountedFolders
    return Array.isArray(folders)
      ? folders.filter(
          (folder): folder is MountedFolder =>
            !!folder && typeof (folder as MountedFolder).hostPath === 'string',
        )
      : []
  })
}

function withoutLegacyMountedFolders(file: SessionFile): SessionFile {
  const raw = file.settings[HARNESS_CHAT_PRESET]
  const entry = parseSessionSettings(file.settings)[HARNESS_CHAT_PRESET]
  if (!entry || !raw) return file
  const bags = Object.fromEntries(
    Object.entries(entry.bags).map(([key, bag]) => {
      const { mountedFolders: _moved, ...values } = bag.values
      return [key, { ...bag, values }]
    }),
  )
  return {
    ...file,
    settings: { ...file.settings, [HARNESS_CHAT_PRESET]: { ...entry, bags } },
  }
}

/**
 * The file with its folder list in place: the app-created Workspace for a file that has none,
 * and Mounted Folders still in the Assistant's settings moved in under the names they had.
 */
export function withSessionFolderList(file: SessionFile): SessionFile {
  const legacy = legacyMountedFolders(file)
  const hasList = file.folders !== undefined && file.workspaceFolderId !== undefined
  if (hasList && legacy.length === 0) return file
  const folders = [...(file.folders ?? [])]
  const known = new Set(folders.map((folder) => path.resolve(folder.hostPath)))
  const moved: SessionFolderEntry[] = []
  for (const folder of resolveMountedFolders(legacy)) {
    if (known.has(path.resolve(folder.hostPath))) continue
    known.add(path.resolve(folder.hostPath))
    const taken = [...folders, ...moved].map((entry) => entry.slug.toLowerCase())
    const slug = taken.includes(folder.name.toLowerCase())
      ? assignSlug(folder.name, taken)
      : folder.name
    // Derived ids, so the list reads the same before and after it is written.
    moved.push({
      id: `folder-moved-${slug.toLowerCase()}`,
      hostPath: folder.hostPath,
      access: folder.access,
      slug,
    })
  }
  let workspaceFolderId = file.workspaceFolderId
  if (!workspaceFolderId || !folders.some((folder) => folder.id === workspaceFolderId)) {
    const workspace = appCreatedWorkspaceEntry(
      file.id,
      [...folders, ...moved].map((entry) => entry.slug),
      'folder-workspace',
    )
    folders.unshift(workspace)
    workspaceFolderId = workspace.id
  }
  return {
    ...withoutLegacyMountedFolders(file),
    folders: [...folders, ...moved],
    workspaceFolderId,
  }
}

/** Every slug the Session has given out, so none is given twice. */
export function takenSlugsOf(list: SessionFolderList): string[] {
  return artifactFoldersOf(list).map((folder) => folder.slug)
}

export function sessionFolderListOf(file: SessionFile): SessionFolderList {
  const {
    folders = [],
    workspaceFolderId = '',
    detachedFolders = [],
    agentFolders = [],
  } = withSessionFolderList(file)
  return {
    folders,
    workspaceId: workspaceFolderId,
    ...(detachedFolders.length > 0 ? { detached: detachedFolders } : {}),
    ...(agentFolders.length > 0 ? { agentOwned: agentFolders } : {}),
  }
}

/** Every folder an Artifact of the Session can be in: listed, detached, then Agents' own. */
export function artifactFoldersOf(list: SessionFolderList): SessionFolderEntry[] {
  return [...list.folders, ...(list.detached ?? []), ...(list.agentOwned ?? [])]
}
