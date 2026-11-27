import path from 'node:path'
import { artifactHostPath } from './historyArtifacts'
import { readSessionFolders } from './sessionFolders'
import { sessionPaths } from './sessions'
import type { OverviewSummaryPicture } from '@/types/sessionIpc'

/** A file under `root` as a forward-slash relative path; null when it is outside. */
export function relativeInside(root: string, file: string): string | null {
  const relative = path.relative(root, file)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : null
}

/**
 * The file a stored picture names: relative to its folder, the Session's artifact
 * root, or absolute for a game icon outside every Session folder. A relative path
 * that escapes its root resolves to nothing.
 */
export async function storedPictureHostPath(
  sessionId: string,
  picture: OverviewSummaryPicture,
): Promise<string | undefined> {
  if (picture.folderId) {
    const list = await readSessionFolders(sessionId)
    return (
      artifactHostPath(
        sessionId,
        { folderId: picture.folderId, path: picture.path, mediaType: picture.mediaType },
        list,
      ) ?? undefined
    )
  }
  if (path.isAbsolute(picture.path)) return path.resolve(picture.path)
  const root = sessionPaths(sessionId).artifactRoot
  const file = path.resolve(root, picture.path)
  return relativeInside(root, file) ? file : undefined
}
