import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { exists, mergeInto, moveEntry, removeEmptyFolder } from './fileOps'
import {
  isSessionId,
  SESSION_ATTACHMENTS_DIR,
  SESSION_FILE,
  SESSION_HISTORY_FILE,
} from './sessionFiles'
import { SESSION_GROUPS_FILE } from './sessionGroupsFile'
import { getLegacySessionsDir, getSessionsDir } from './userDataPaths.ts'

const LOG_SCOPE = 'sessions'

/** A record or History that already arrived is the one to keep. */
async function moveOnce(from: string, to: string): Promise<boolean> {
  if (!(await exists(from))) return false
  if (await exists(to)) {
    await fs.unlink(from)
    return false
  }
  await moveEntry(from, to)
  return true
}

async function moveSession(id: string): Promise<boolean> {
  const from = path.join(getLegacySessionsDir(), id)
  const to = path.join(getSessionsDir(), id)
  // History before the record, so a Session never lists without its History.
  await moveOnce(path.join(from, SESSION_HISTORY_FILE), path.join(to, SESSION_HISTORY_FILE))
  await mergeInto(path.join(from, SESSION_ATTACHMENTS_DIR), path.join(to, SESSION_ATTACHMENTS_DIR))
  const moved = await moveOnce(path.join(from, SESSION_FILE), path.join(to, SESSION_FILE))
  await removeEmptyFolder(from)
  return moved
}

/**
 * Moves each Session's record, History and attachments, and the groups file, out of
 * `AI-Playground/sessions/` into the app's internal storage; `files/` stays. Idempotent and
 * resumable: whatever already arrived wins.
 */
export async function moveSessionBookkeeping(): Promise<void> {
  const legacy = getLegacySessionsDir()
  if (path.resolve(legacy) === path.resolve(getSessionsDir())) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(legacy, { withFileTypes: true })
  } catch {
    return
  }
  let moved = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSessionId(entry.name)) continue
    try {
      if (await moveSession(entry.name)) moved += 1
    } catch (error) {
      appLoggerInstance.warn(`could not move session ${entry.name}: ${String(error)}`, LOG_SCOPE)
    }
  }
  await moveOnce(
    path.join(legacy, SESSION_GROUPS_FILE),
    path.join(getSessionsDir(), SESSION_GROUPS_FILE),
  )
  if (moved > 0) appLoggerInstance.info(`moved ${moved} session record(s)`, LOG_SCOPE)
}
