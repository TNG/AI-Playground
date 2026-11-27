import fs from 'node:fs'
import path from 'node:path'
import type { SessionFileAction, SessionFileReadResult } from '@/types/agentIpc'
import type { IpcMutationResult } from '@/types/ipcChannels'
import type { SessionFileMounts } from './sessionWorkspace.ts'

// ── Open, reveal or delete a file an agent turn wrote ───────────────────────
//
// The transcript linkifies the paths exactly as the model wrote them, so the
// resolution to a real host path happens here, against the session's own
// mounts (agent/sessionWorkspace.ts) — a host path is never taken from the
// renderer, and anything outside the session's folders is refused.

export type SessionFileDeps = {
  mountsOf: (sessionId: string) => Promise<SessionFileMounts | null>
  /** `shell.openPath`: resolves '' on success, the OS error text otherwise. */
  open: (filePath: string) => Promise<string>
  reveal: (filePath: string) => unknown
  /** To the OS Trash (permanent in demo mode); the workspace's own file leaves for good. */
  delete: (filePath: string) => Promise<void>
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function realOrResolved(target: string): string {
  try {
    return fs.realpathSync(target)
  } catch {
    // A path through deleted folders must carry its deepest surviving
    // ancestor's canonical prefix, or the containment check misreads a gone
    // file as an escape (macOS /var vs /private/var).
    let dir = path.dirname(target)
    const tail = [path.basename(target)]
    while (true) {
      try {
        return path.join(fs.realpathSync(dir), ...tail.reverse())
      } catch {
        if (dir === path.dirname(dir)) return path.resolve(target)
        tail.push(path.basename(dir))
        dir = path.dirname(dir)
      }
    }
  }
}

/** The host path a sandbox-style reference names, or null when it names no mount. */
function resolveAgainstMounts(mounts: SessionFileMounts, rawPath: string): string | null {
  const reference = rawPath.replace(/\\/g, '/')
  const under = (prefix: string): string | null =>
    reference.startsWith(`${prefix.replace(/\/+$/, '')}/`)
      ? reference.slice(prefix.replace(/\/+$/, '').length + 1)
      : null
  const workdir = under(mounts.workdir)
  if (workdir !== null) return path.join(mounts.workspaceDir, ...workdir.split('/'))
  for (const folder of mounts.mounted) {
    const relative = under(`/mnt/${folder.name}`)
    if (relative !== null) return path.join(folder.hostPath, ...relative.split('/'))
  }
  return null
}

/** The host file a turn's `rawPath` names; null when it is gone, throws when it leaves the session's folders. */
export function resolveSessionFilePath(mounts: SessionFileMounts, rawPath: string): string | null {
  const candidate =
    resolveAgainstMounts(mounts, rawPath) ??
    (path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(mounts.workspaceDir, rawPath))
  const real = realOrResolved(candidate)
  const contained = [mounts.workspaceDir, ...mounts.mounted.map((folder) => folder.hostPath)].some(
    (root) => isInside(realOrResolved(root), real),
  )
  if (!contained) throw new Error(`Path escapes the session's folders: ${rawPath}`)
  if (!isFile(real)) return null
  return real
}

export function sessionFileActions(deps: SessionFileDeps) {
  return async (
    sessionId: string,
    rawPath: string,
    action: SessionFileAction,
  ): Promise<IpcMutationResult> => {
    try {
      if (!sessionId || !rawPath) return { success: false, error: 'invalid file request' }
      const mounts = await deps.mountsOf(sessionId)
      if (!mounts) return { success: false, error: 'This session has no workspace folder.' }
      const filePath = resolveSessionFilePath(mounts, rawPath)
      if (!filePath) return { success: false, error: 'The file no longer exists.' }
      if (action === 'open') {
        const error = await deps.open(filePath)
        if (error) return { success: false, error }
      } else if (action === 'delete') {
        await deps.delete(filePath)
      } else {
        await deps.reveal(filePath)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

// ── Read a written file for the transcript's inline preview ────────────────

/** A preview is a peek: it shows the file's first lines, not its whole body. */
export const SESSION_FILE_PREVIEW_LINES = 10
/** Ceiling for the one case a line count cannot catch: a huge minified line. */
export const SESSION_FILE_PREVIEW_CAP = 16 * 1024
/** A "Show more" expansion drops the line cap but still refuses to choke on a huge file. */
export const SESSION_FILE_FULL_PREVIEW_CAP = 1024 * 1024

export function sessionFileReader(deps: Pick<SessionFileDeps, 'mountsOf'>) {
  return async (
    sessionId: string,
    rawPath: string,
    full?: boolean,
  ): Promise<SessionFileReadResult> => {
    try {
      if (!sessionId || !rawPath) return { success: false, error: 'invalid file request' }
      const mounts = await deps.mountsOf(sessionId)
      if (!mounts) return { success: false, error: 'This session has no workspace folder.' }
      const filePath = resolveSessionFilePath(mounts, rawPath)
      if (!filePath) return { success: false, error: 'The file no longer exists.', missing: true }
      const bytes = await fs.promises.readFile(filePath)
      const byteCap = full ? SESSION_FILE_FULL_PREVIEW_CAP : SESSION_FILE_PREVIEW_CAP
      const byteTruncated = bytes.byteLength > byteCap
      const text = byteTruncated
        ? bytes.subarray(0, byteCap).toString('utf8')
        : bytes.toString('utf8')
      // `split` keeps each line's own \r, so CRLF files survive the rejoin.
      const lines = text.split('\n')
      const lineTruncated = !full && lines.length > SESSION_FILE_PREVIEW_LINES
      const content = lineTruncated ? lines.slice(0, SESSION_FILE_PREVIEW_LINES).join('\n') : text
      return { success: true, data: { content, truncated: byteTruncated || lineTruncated } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
