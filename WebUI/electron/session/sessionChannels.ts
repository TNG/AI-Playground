import path from 'node:path'
import { emitSessionChanged } from '../kernel/kernelBus'
import { forgetSessionMessages } from '../persist/channelMessageMap'
import { listSessionFolders, readSessionFile } from '../persist/sessionFiles'
import {
  mutateSession,
  onSessionDeleted,
  sessionDocumentOf,
  sessionPaths,
  withNotify,
} from './sessions'
import type { AssistantCapabilityDefaults, SessionFile, SessionSummary } from '@/types/sessionIpc'

// What Channels may do with a Session (Reachable Session, docs/adr/0010).

export const REAL_SHELL_REACHABLE_REFUSAL =
  'A Session that uses the real system shell cannot be reachable from Channels'

// The real shell is a per-folder opt-in the window keeps, so the window pushes it here.
let realShellFolders = new Set<string>()

function usesRealShell(file: SessionFile): boolean {
  const folders = [sessionPaths(file.id).filesDir, ...Object.values(file.harnessWorkspaces)]
  return folders.some((folder) => realShellFolders.has(path.resolve(folder)))
}

function changed(file: SessionFile): SessionSummary {
  const document = sessionDocumentOf(file)
  emitSessionChanged(document)
  const { timeline: _timeline, ...summary } = document
  return summary
}

/** Turning reachable on also lets the Session's Assistant notify; refused with the real shell. */
export async function setSessionReachable(
  id: string,
  reachable: boolean,
  options: AssistantCapabilityDefaults = {},
): Promise<SessionSummary> {
  const file = await mutateSession(id, (current) => {
    if (!reachable) return { ...current, reachable }
    if (usesRealShell(current)) throw new Error(REAL_SHELL_REACHABLE_REFUSAL)
    return withNotify({ ...current, reachable }, options.defaultCapabilities)
  })
  return changed(file)
}

/** The Session while it is reachable; null when it is not, is gone or cannot be read. */
export async function readReachableSession(id: string): Promise<SessionFile | null> {
  const read = await readSessionFile(id).catch(() => null)
  return read?.status === 'ok' && read.file.reachable ? read.file : null
}

export async function isSessionReachable(id: string): Promise<boolean> {
  return (await readReachableSession(id)) !== null
}

/** The folders the real shell is on now; a Reachable Session in one stops being reachable. */
export async function setRealShellFolders(folders: string[]): Promise<void> {
  realShellFolders = new Set(folders.map((folder) => path.resolve(folder)))
  for (const { id } of await listSessionFolders()) {
    const read = await readSessionFile(id)
    if (read.status !== 'ok' || !read.file.reachable || !usesRealShell(read.file)) continue
    changed(await mutateSession(id, (current) => ({ ...current, reachable: false })))
  }
}

/** A deleted Session's Channel messages answer that it was deleted; returns the unsubscribe. */
export function forgetChannelMessagesOnDelete(): () => void {
  return onSessionDeleted((id) => forgetSessionMessages(id))
}

export function resetSessionChannelsForTest(): void {
  realShellFolders = new Set()
}
