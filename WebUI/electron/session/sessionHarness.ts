import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { ensureSessionFilesDir } from '../persist/sessionMediaFiles'
import { getGamesDir } from '../persist/userDataPaths'
import { listSessionFolders, readSessionFile } from '../persist/sessionFiles'
import { mutateSession, onSessionDeleted } from './sessions'
import type { HarnessGameWorkspace, HarnessSessionRef, SessionFile } from '@/types/sessionIpc'

export function mintHarnessSessionId(): string {
  return `aipg-agent-${randomUUID()}`
}

function requireGameFolder(dir: string): string {
  const resolved = path.resolve(dir)
  const inLibrary = path.relative(path.resolve(getGamesDir()), resolved)
  if (!inLibrary || inLibrary.startsWith('..') || path.isAbsolute(inLibrary)) {
    throw new Error(`not a game folder in the games library: ${dir}`)
  }
  return resolved
}

function withGameHarness(
  current: SessionFile,
  presetName: string,
  game: HarnessGameWorkspace,
  gameDir: string | undefined,
): SessionFile {
  const existing = current.harnessSessions[presetName]
  const replace = !!game.fresh && !!existing
  if (existing && !replace && (current.harnessWorkspaces[presetName] || !gameDir)) return current
  return {
    ...current,
    harnessSessions: {
      ...current.harnessSessions,
      [presetName]: existing && !replace ? existing : mintHarnessSessionId(),
    },
    harnessWorkspaces: gameDir
      ? { ...current.harnessWorkspaces, [presetName]: gameDir }
      : current.harnessWorkspaces,
    retiredHarnessSessions: replace
      ? [...current.retiredHarnessSessions, existing]
      : current.retiredHarnessSessions,
  }
}

/**
 * One Harness Session per (Session, agent preset). A games preset's game folder lives in the
 * games library and is never the Session's to delete.
 */
export async function harnessSessionFor(
  sessionId: string,
  presetName: string,
  game?: HarnessGameWorkspace,
): Promise<HarnessSessionRef> {
  if (game) {
    const gameDir = game.gameDir ? requireGameFolder(game.gameDir) : undefined
    const file = await mutateSession(sessionId, (current) =>
      withGameHarness(current, presetName, game, gameDir),
    )
    return {
      harnessSessionId: file.harnessSessions[presetName],
      workspaceDir: file.harnessWorkspaces[presetName] ?? '',
    }
  }
  const file = await mutateSession(sessionId, (current) =>
    current.harnessSessions[presetName]
      ? current
      : {
          ...current,
          harnessSessions: {
            ...current.harnessSessions,
            [presetName]: mintHarnessSessionId(),
          },
        },
  )
  const workspaceDir = await ensureSessionFilesDir(sessionId)
  return { harnessSessionId: file.harnessSessions[presetName], workspaceDir }
}

function harnessSessionsOf(file: SessionFile): string[] {
  return [
    ...Object.values(file.harnessSessions),
    ...file.retiredHarnessSessions,
    ...file.taskRunHarnessSessions,
  ]
}

/** Every Harness Session id → the Session it belongs to. Trial Runs belong to none. */
export async function harnessSessionOwners(): Promise<Map<string, string>> {
  const owners = new Map<string, string>()
  for (const { id } of await listSessionFolders()) {
    const read = await readSessionFile(id)
    if (read.status !== 'ok') continue
    for (const harnessSessionId of harnessSessionsOf(read.file)) owners.set(harnessSessionId, id)
  }
  return owners
}

export async function sessionOfHarnessSession(harnessSessionId: string): Promise<string | null> {
  return (await harnessSessionOwners()).get(harnessSessionId) ?? null
}

export type HarnessCleanup = (harnessSessionId: string) => Promise<unknown>

/** Deleting a Session deletes its Harness Sessions' Pi files and records; returns the unsubscribe. */
export function cleanUpHarnessSessionsOnDelete(cleanup: HarnessCleanup): () => void {
  return onSessionDeleted(async (_id, deleted) => {
    const ids = deleted ? harnessSessionsOf(deleted) : []
    for (const harnessSessionId of ids) {
      await cleanup(harnessSessionId)
    }
  })
}
