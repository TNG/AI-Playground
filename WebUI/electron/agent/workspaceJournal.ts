import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { appLoggerInstance } from '../observability/logger.ts'
import { isWritable, type ResolvedMountedFolder } from '@/lib/mountedFolders'

// ── Per-turn workspace journal ───────────────────────────────────────────────
//
// The harness turns are deletable and re-runnable (regenerate rewinds Pi's
// transcript), but a turn's file work used to be permanent: the game it wrote
// stayed half-renamed, the cover it generated stayed in `generated/`. This
// module gives every turn a "diary" of its workspace writes so a later step can
// put the workspace back exactly as the turn found it.
//
// Recording is copy-on-write and first-touch: the first time a turn touches a
// path, the path's pre-turn state is captured — a file's original bytes go to a
// blob beside the manifest, a missing path is noted as `created`. Whatever the
// turn does afterwards (write, delete, rename) does not change the entry, so
// restoring means applying the captured state of every touched path, nothing
// more. Journals compose: rolling back the newest turn restores the state its
// predecessor left behind, so deleting turns one by one, newest first, unwinds
// the workspace correctly.
//
// Only paths inside the turn's writable roots (the workspace and read-write
// Mounted Folders) are recorded, so Session-side media copies and the app's own
// files stay out. Recording is best-effort by design: a failure is logged and
// the write proceeds, because the diary must never cost the turn.

const logger = appLoggerInstance
const LOG_SOURCE = 'workspaceJournal'

/** Files larger than this are noted but not backed up; restoring skips them. */
const DEFAULT_BACKUP_CAP_BYTES = 64 * 1024 * 1024
let backupCapBytes = DEFAULT_BACKUP_CAP_BYTES

/** Tests shrink the cap; a 64 MB fixture would say more about disk speed. */
export function setJournalBackupCapForTest(bytes: number): void {
  backupCapBytes = bytes
}

export type JournalEntry =
  | { kind: 'created'; path: string; isDir?: boolean }
  | { kind: 'dir'; path: string }
  | { kind: 'file'; path: string; blob: string; mode: number }
  | { kind: 'symlink'; path: string; target: string }
  | { kind: 'unrestorable'; path: string }

export type JournalManifest = {
  schemaVersion: 1
  sessionId: string
  turnId: string
  /** Realpathed workspace folder; reference, the roots decide recording. */
  workspaceDir: string
  /** True when the turn ran with the unsandboxed host shell. */
  unsandboxed?: boolean
  createdAt: number
  entries: JournalEntry[]
}

type TurnJournal = {
  manifest: JournalManifest
  /** Writable host roots (workspace + read-write Mounted Folders), realpathed. */
  roots: string[]
  /** Entry paths already captured — first touch wins. */
  recorded: Set<string>
  dir: string
  nextBlob: number
}

/** One open journal per session — a session runs one turn at a time. */
const journals = new Map<string, TurnJournal>()

function journalRoot(): string {
  return path.join(app.getPath('userData'), 'agent-workspace-journal')
}

function journalDirOf(sessionId: string, turnId: string): string {
  return path.join(journalRoot(), sessionId, turnId)
}

/**
 * A host path normalized the way the journal keys and roots it: the deepest
 * existing ancestor is realpathed (macOS `/tmp` → `/private/tmp`), and any
 * missing tail below it is re-attached unchanged. The leaf is never resolved
 * through a symlink of its own — a recorded symlink must keep its own path.
 */
function normalizedHostPath(candidate: string): string {
  let resolved = path.resolve(candidate)
  const tail: string[] = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(resolved), ...tail)
    } catch {
      // Not there yet: walk up and remember the missing part.
    }
    const parent = path.dirname(resolved)
    if (parent === resolved) return path.resolve(candidate)
    tail.unshift(path.basename(resolved))
    resolved = parent
  }
}

function insideRoots(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => {
    const relative = path.relative(root, candidate)
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  })
}

/** The host roots a turn's writes are recorded within. */
export function journalRootsOf(
  workspaceDir: string,
  mountedFolders: readonly ResolvedMountedFolder[],
): string[] {
  return [
    normalizedHostPath(workspaceDir),
    ...mountedFolders.filter(isWritable).map((folder) => normalizedHostPath(folder.hostPath)),
  ]
}

function persistManifest(journal: TurnJournal): void {
  fs.mkdirSync(journal.dir, { recursive: true })
  const target = path.join(journal.dir, 'journal.json')
  const temp = `${target}.tmp`
  fs.writeFileSync(temp, JSON.stringify(journal.manifest, null, 2))
  fs.renameSync(temp, target)
}

function addEntry(journal: TurnJournal, entry: JournalEntry): void {
  journal.manifest.entries.push(entry)
}

/** Missing ancestors a create implicitly brings into being, deepest first. */
function recordMissingAncestors(journal: TurnJournal, filePath: string): void {
  for (let dir = path.dirname(filePath); ; dir = path.dirname(dir)) {
    if (!insideRoots(dir, journal.roots) || journal.recorded.has(dir)) return
    if (fs.existsSync(dir)) return
    journal.recorded.add(dir)
    addEntry(journal, { kind: 'created', path: dir, isDir: true })
  }
}

function recordPath(journal: TurnJournal, rawPath: string, isDirHint = false): void {
  const filePath = normalizedHostPath(rawPath)
  if (journal.recorded.has(filePath) || !insideRoots(filePath, journal.roots)) return
  journal.recorded.add(filePath)

  let stat: fs.Stats
  try {
    stat = fs.lstatSync(filePath)
  } catch {
    addEntry(journal, { kind: 'created', path: filePath, ...(isDirHint ? { isDir: true } : {}) })
    recordMissingAncestors(journal, filePath)
    return
  }

  if (stat.isDirectory()) {
    // A `rm -rf` or `mv` of a folder deletes everything in it, so every child's
    // pre-state is captured now, not just the folder's own entry.
    addEntry(journal, { kind: 'dir', path: filePath })
    for (const name of fs.readdirSync(filePath)) recordPath(journal, path.join(filePath, name))
    return
  }
  if (stat.isSymbolicLink()) {
    try {
      addEntry(journal, { kind: 'symlink', path: filePath, target: fs.readlinkSync(filePath) })
    } catch (error) {
      logger.warn(`journal: unreadable symlink ${filePath}: ${error}`, LOG_SOURCE)
    }
    return
  }
  if (!stat.isFile()) return
  if (stat.size > backupCapBytes) {
    addEntry(journal, { kind: 'unrestorable', path: filePath })
    return
  }
  const blob = `blob-${journal.nextBlob}`
  journal.nextBlob += 1
  fs.mkdirSync(journal.dir, { recursive: true })
  fs.copyFileSync(filePath, path.join(journal.dir, blob))
  addEntry(journal, { kind: 'file', path: filePath, blob, mode: stat.mode })
}

/** Open this session's journal for the turn about to run. */
export function beginTurnJournal(info: {
  sessionId: string
  turnId: string
  workspaceDir: string
  mountedFolders?: ResolvedMountedFolder[]
  unsandboxed?: boolean
}): void {
  const { sessionId, turnId } = info
  journals.set(sessionId, {
    manifest: {
      schemaVersion: 1,
      sessionId,
      turnId,
      workspaceDir: normalizedHostPath(info.workspaceDir),
      ...(info.unsandboxed ? { unsandboxed: true } : {}),
      createdAt: Date.now(),
      entries: [],
    },
    roots: journalRootsOf(info.workspaceDir, info.mountedFolders ?? []),
    recorded: new Set<string>(),
    dir: journalDirOf(sessionId, turnId),
    nextBlob: 0,
  })
}

/** Close the journal when the turn settles; the manifest is already on disk. */
export function endTurnJournal(sessionId: string): void {
  journals.delete(sessionId)
}

/**
 * Capture the pre-turn state of a path a turn is about to write. No journal
 * open for the session (no turn, or a write from outside one), or the path
 * outside the turn's writable roots: nothing recorded. Best-effort — a failure
 * is logged and never propagated to the tool call it guards.
 */
export function recordWorkspaceWrite(sessionId: string, absolutePath: string): void {
  const journal = journals.get(sessionId)
  if (!journal) return
  try {
    recordPath(journal, absolutePath)
    if (journal.manifest.entries.length > 0) persistManifest(journal)
  } catch (error) {
    logger.warn(`journal: failed to record ${absolutePath}: ${error}`, LOG_SOURCE)
  }
}

export type JournalRestoreReport = {
  removedCreated: number
  restored: number
  unrestorable: string[]
}

function depthOf(filePath: string): number {
  return filePath.split(path.sep).length
}

/**
 * Put the workspace back as the turn found it: remove what the turn created
 * (deepest first, so emptied folders go too), re-create folders it deleted,
 * write backed-up files back, re-point symlinks. A journal that never existed
 * (a turn from before the journal did, or one that wrote nothing) restores as
 * `undefined` — there is nothing it changed.
 */
export function restoreTurnJournal(
  sessionId: string,
  turnId: string,
): JournalRestoreReport | undefined {
  const dir = journalDirOf(sessionId, turnId)
  let manifest: JournalManifest | undefined
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'journal.json'), 'utf-8'))
  } catch {
    return undefined
  }
  if (!manifest || manifest.sessionId !== sessionId) return undefined

  const report: JournalRestoreReport = { removedCreated: 0, restored: 0, unrestorable: [] }
  const entries = manifest.entries

  const created = entries
    .filter(
      (entry): entry is Extract<JournalEntry, { kind: 'created' }> => entry.kind === 'created',
    )
    .sort((a, b) => depthOf(b.path) - depthOf(a.path))
  for (const entry of created) {
    fs.rmSync(entry.path, { recursive: true, force: true })
    report.removedCreated += 1
  }

  const dirs = entries
    .filter((entry): entry is Extract<JournalEntry, { kind: 'dir' }> => entry.kind === 'dir')
    .sort((a, b) => depthOf(a.path) - depthOf(b.path))
  for (const entry of dirs) {
    fs.mkdirSync(entry.path, { recursive: true })
    report.restored += 1
  }

  for (const entry of entries) {
    if (entry.kind === 'unrestorable') {
      report.unrestorable.push(entry.path)
      continue
    }
    if (entry.kind !== 'file' && entry.kind !== 'symlink') continue
    fs.mkdirSync(path.dirname(entry.path), { recursive: true })
    // Whatever the turn left there — including a folder grown over the path —
    // goes, so the captured state can be put back in its place.
    fs.rmSync(entry.path, { recursive: true, force: true })
    if (entry.kind === 'symlink') {
      fs.symlinkSync(entry.target, entry.path)
      report.restored += 1
      continue
    }
    const blob = path.join(dir, entry.blob)
    if (!fs.existsSync(blob)) {
      report.unrestorable.push(entry.path)
      continue
    }
    fs.copyFileSync(blob, entry.path)
    try {
      fs.chmodSync(entry.path, entry.mode & 0o777)
    } catch {
      // A filesystem that refuses the original mode still gets the bytes back.
    }
    report.restored += 1
  }

  return report
}

/** Drop one turn's journal from disk (after a restore or a delete consumed it). */
export function deleteTurnJournal(sessionId: string, turnId: string): void {
  fs.rmSync(journalDirOf(sessionId, turnId), { recursive: true, force: true })
}

/** Drop every journal of a session (the session's turns can no longer be redone). */
export function deleteSessionJournals(sessionId: string): void {
  journals.delete(sessionId)
  fs.rmSync(path.join(journalRoot(), sessionId), { recursive: true, force: true })
}

export function resetWorkspaceJournalsForTest(): void {
  journals.clear()
}
