import { randomUUID } from 'node:crypto'
import { emitSessionChanged, emitSessionGroupsChanged } from '../kernel/kernelBus'
import {
  assertSessionId,
  createSessionFolder,
  listSessionFolders,
  readSessionFile,
  removeSessionFolder,
  resetSessionFilesForTest,
  serializeSession,
  sessionFolderPaths,
  sessionsRoot,
  setSessionFileDeps,
  wipeDemoSessionFolders,
  writeSessionFile,
  type SessionFileDeps,
  type SessionFolderPaths,
} from '../persist/sessionFiles'
import {
  readSessionGroupsFile,
  resetSessionGroupsFileForTest,
  serializeSessionGroups,
  writeSessionGroupsFile,
} from '../persist/sessionGroupsFile'
import { readHistoryEntries } from './sessionHistory'
import { autoTitle } from './sessionTitle'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { checkGroupName, groupNameRefusal } from '@/lib/sessionGroupName'
import { NOTIFY_CAPABILITY_ID } from '@/types/agentCapabilities'
import {
  SessionTitleSchema,
  type AssistantCapabilityDefaults,
  type SessionDocument,
  type SessionFile,
  type SessionGroup,
  type SessionGroupsFile,
  type SessionSummary,
  type ShowMore,
  type ShowMoreSection,
} from '@/types/sessionIpc'
import { parseSessionSettings } from '@/types/sessionSettings'

// The Session module (ADR-0003), sole owner of every Session Folder.

/** `deleted` is the Session's last `session.json`, null when it could not be read. */
export type SessionDeletedListener = (
  id: string,
  deleted: SessionFile | null,
) => void | Promise<void>

const deletedListeners = new Set<SessionDeletedListener>()

const UNAVAILABLE_TITLE = 'Unavailable session'

export function setSessionDeps(deps: SessionFileDeps): void {
  setSessionFileDeps(deps)
}

/** The folder every Session Folder lives in (the demo root in demo mode). */
export function sessionsRootDir(): string {
  return sessionsRoot()
}

export function sessionPaths(id: string): SessionFolderPaths {
  return sessionFolderPaths(id)
}

function summaryOf(file: SessionFile): SessionSummary {
  const {
    id,
    title,
    renamed,
    pinned,
    groupId,
    createdAt,
    updatedAt,
    presetsUsed,
    pickedAgentId,
    reachable,
  } = file
  return {
    id,
    title,
    renamed,
    pinned,
    reachable,
    ...(groupId === undefined ? {} : { groupId }),
    createdAt,
    updatedAt,
    presetsUsed,
    ...(pickedAgentId === undefined ? {} : { pickedAgentId }),
  }
}

export async function readSession(id: string): Promise<SessionFile> {
  const read = await readSessionFile(id)
  if (read.status === 'ok') return read.file
  throw new Error(
    read.status === 'missing' ? `no such session: ${id}` : `session unreadable: ${id}`,
  )
}

/** Adds `notify` to the Session's Assistant capabilities, its own or else the defaults. */
export function withNotify(
  file: SessionFile,
  defaultCapabilities: string[] | undefined,
): SessionFile {
  const entry = parseSessionSettings(file.settings)[HARNESS_CHAT_PRESET] ?? { bags: {} }
  const bag = entry.bags[HARNESS_CHAT_PRESET] ?? { values: {}, fromDefaults: true }
  const stored = bag.values.capabilities
  const own = Array.isArray(stored) ? (stored as string[]) : undefined
  const capabilities = own ?? defaultCapabilities
  if (!capabilities || own?.includes(NOTIFY_CAPABILITY_ID)) return file
  const withId = capabilities.includes(NOTIFY_CAPABILITY_ID)
    ? capabilities
    : [...capabilities, NOTIFY_CAPABILITY_ID]
  const next = { ...bag, values: { ...bag.values, capabilities: withId } }
  const nextEntry = { ...entry, bags: { ...entry.bags, [HARNESS_CHAT_PRESET]: next } }
  return { ...file, settings: { ...file.settings, [HARNESS_CHAT_PRESET]: nextEntry } }
}

/** A new Session starts reachable, as if reachability had been turned on by hand. */
export async function createSession(
  groupId?: string,
  options: AssistantCapabilityDefaults = {},
): Promise<SessionSummary> {
  if (groupId === undefined) return createSessionFile(undefined, options)
  return serializeSessionGroups(async () => {
    requireGroup((await readGroupsForWrite()).groups, groupId)
    return createSessionFile(groupId, options)
  })
}

async function createSessionFile(
  groupId: string | undefined,
  options: AssistantCapabilityDefaults,
): Promise<SessionSummary> {
  const now = Date.now()
  const created: SessionFile = {
    schemaVersion: 1,
    id: `session-${randomUUID()}`,
    title: '',
    renamed: false,
    pinned: false,
    groupId,
    createdAt: now,
    updatedAt: now,
    presetsUsed: [],
    timeline: [],
    settings: {},
    harnessSessions: {},
    harnessWorkspaces: {},
    retiredHarnessSessions: [],
    taskRunHarnessSessions: [],
    updateCursors: {},
    reachable: true,
  }
  const reachable = withNotify(created, options.defaultCapabilities)
  await serializeSession(reachable.id, () => createSessionFolder(reachable))
  return summaryOf(reachable)
}

/** Newest first. A Session whose `session.json` is unreadable stays listed so it can be deleted. */
export async function listSessions(): Promise<SessionSummary[]> {
  const folders = await listSessionFolders()
  const rows = await Promise.all(
    folders.map(async ({ id, mtimeMs }): Promise<SessionSummary | null> => {
      const read = await readSessionFile(id)
      if (read.status === 'ok') return summaryOf(read.file)
      if (read.status === 'missing') return null
      const time = Math.floor(mtimeMs)
      return {
        id,
        title: UNAVAILABLE_TITLE,
        renamed: false,
        pinned: false,
        reachable: false,
        unreadable: true,
        createdAt: time,
        updatedAt: time,
        presetsUsed: [],
      }
    }),
  )
  return rows
    .filter((row): row is SessionSummary => row !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)
}

export function sessionDocumentOf(file: SessionFile): SessionDocument {
  return { ...summaryOf(file), timeline: file.timeline }
}

export async function openSession(id: string): Promise<SessionDocument> {
  return sessionDocumentOf(await readSession(id))
}

/** Read-modify-write of one `session.json` on that Session's write chain. */
export async function mutateSession(
  id: string,
  mutate: (file: SessionFile) => SessionFile | Promise<SessionFile>,
): Promise<SessionFile> {
  assertSessionId(id)
  return serializeSession(id, async () => {
    const next = await mutate(await readSession(id))
    await writeSessionFile(next)
    return next
  })
}

async function clearedTitle(id: string): Promise<string> {
  const [first] = await readHistoryEntries(id)
  return first ? autoTitle(first) : ''
}

/**
 * A blank title clears the Name, back to the Title the first History Entry gives.
 * History is read on the write chain so a first turn settling alongside keeps its Title.
 */
export async function renameSession(id: string, title: string): Promise<SessionSummary> {
  const name = title.trim() ? SessionTitleSchema.parse(title) : null
  const file = await mutateSession(id, async (current) => {
    const [nextTitle, renamed] = name === null ? [await clearedTitle(id), false] : [name, true]
    return { ...current, title: nextTitle, renamed }
  })
  emitSessionChanged(sessionDocumentOf(file))
  return summaryOf(file)
}

export async function pinSession(id: string, pinned: boolean): Promise<SessionSummary> {
  const file = await mutateSession(id, (current) => ({ ...current, pinned }))
  emitSessionChanged(sessionDocumentOf(file))
  return summaryOf(file)
}

/** Pick an Agent in the Session's prompt bar, or `null` for Assistant itself. */
export async function pickSessionAgent(
  id: string,
  agentId: string | null,
): Promise<SessionSummary> {
  const file = await mutateSession(id, ({ pickedAgentId: _previous, ...current }) =>
    agentId === null ? current : { ...current, pickedAgentId: agentId },
  )
  emitSessionChanged(sessionDocumentOf(file))
  return summaryOf(file)
}

async function readGroupsFile(): Promise<SessionGroupsFile | null> {
  const read = await readSessionGroupsFile()
  return read.status === 'ok' ? read.file : null
}

/** The Session Groups of the active root; none while the Groups file cannot be read. */
export async function listSessionGroups(): Promise<SessionGroup[]> {
  return (await readGroupsFile())?.groups ?? []
}

async function readGroupsForWrite(): Promise<SessionGroupsFile> {
  const file = await readGroupsFile()
  if (file) return file
  throw new Error('Session Groups are unavailable: their file cannot be read')
}

async function saveGroupsFile(file: SessionGroupsFile): Promise<void> {
  await writeSessionGroupsFile(file)
  emitSessionGroupsChanged({ groups: file.groups, showMore: showMoreOf(file) })
}

function requireGroup(groups: SessionGroup[], groupId: string): SessionGroup {
  const group = groups.find((candidate) => candidate.id === groupId)
  if (!group) throw new Error(`no such session group: ${groupId}`)
  return group
}

function validGroupName(name: string, groups: SessionGroup[], ownId?: string): string {
  const check = checkGroupName(name, groups, ownId)
  if ('name' in check) return check.name
  throw groupNameRefusal(check.problem)
}

async function setSessionGroup(id: string, groupId: string | null): Promise<SessionSummary> {
  const file = await mutateSession(id, ({ groupId: _previous, ...rest }) =>
    groupId === null ? rest : { ...rest, groupId },
  )
  emitSessionChanged(sessionDocumentOf(file))
  return summaryOf(file)
}

export async function createSessionGroup(
  sessionId: string,
  name: string,
): Promise<{ group: SessionGroup; session: SessionSummary }> {
  assertSessionId(sessionId)
  return serializeSessionGroups(async () => {
    const file = await readGroupsForWrite()
    const group: SessionGroup = {
      id: `group-${randomUUID()}`,
      name: validGroupName(name, file.groups),
      createdAt: Date.now(),
      expanded: true,
    }
    const session = await setSessionGroup(sessionId, group.id)
    await saveGroupsFile({ ...file, groups: [...file.groups, group] })
    return { group, session }
  })
}

/** `null` takes the Session out of its Group, back to Recent (or Pinned). */
export async function moveSessionToGroup(
  sessionId: string,
  groupId: string | null,
): Promise<SessionSummary> {
  assertSessionId(sessionId)
  if (groupId === null) return setSessionGroup(sessionId, null)
  return serializeSessionGroups(async () => {
    requireGroup((await readGroupsForWrite()).groups, groupId)
    return setSessionGroup(sessionId, groupId)
  })
}

async function updateSessionGroup(
  groupId: string,
  update: (group: SessionGroup, groups: SessionGroup[]) => SessionGroup,
): Promise<SessionGroup> {
  return serializeSessionGroups(async () => {
    const file = await readGroupsForWrite()
    const next = update(requireGroup(file.groups, groupId), file.groups)
    const groups = file.groups.map((group) => (group.id === groupId ? next : group))
    await saveGroupsFile({ ...file, groups })
    return next
  })
}

export async function renameSessionGroup(groupId: string, name: string): Promise<SessionGroup> {
  return updateSessionGroup(groupId, (group, groups) => ({
    ...group,
    name: validGroupName(name, groups, groupId),
  }))
}

export async function setSessionGroupExpanded(
  groupId: string,
  expanded: boolean,
): Promise<SessionGroup> {
  return updateSessionGroup(groupId, (group) => ({ ...group, expanded }))
}

/** The Group goes first, so a crash part-way leaves only ids that list as ungrouped. */
export async function deleteSessionGroup(groupId: string): Promise<void> {
  await serializeSessionGroups(async () => {
    const file = await readGroupsForWrite()
    requireGroup(file.groups, groupId)
    await saveGroupsFile({ ...file, groups: file.groups.filter((group) => group.id !== groupId) })
    const members = (await listSessions()).filter(
      (session) => !session.unreadable && session.groupId === groupId,
    )
    for (const member of members) {
      const file = await mutateSession(member.id, (current) => {
        if (current.groupId !== groupId) return current
        const { groupId: _removed, ...rest } = current
        return rest
      })
      emitSessionChanged(sessionDocumentOf(file))
    }
  })
}

const SHOW_MORE_FIELDS = {
  pinned: 'pinnedShowMore',
  older: 'olderShowMore',
} as const satisfies Record<ShowMoreSection, keyof SessionGroupsFile>

function showMoreOf(file: SessionGroupsFile | null): ShowMore {
  return { pinned: file?.pinnedShowMore ?? false, older: file?.olderShowMore ?? false }
}

/** Which shortened sections list every Session; all off while the Groups file cannot be read. */
export async function readShowMore(): Promise<ShowMore> {
  return showMoreOf(await readGroupsFile())
}

export async function setShowMore(section: ShowMoreSection, shown: boolean): Promise<void> {
  await serializeSessionGroups(async () => {
    const file = await readGroupsForWrite()
    await saveGroupsFile({ ...file, [SHOW_MORE_FIELDS[section]]: shown })
  })
}

/** Removes the Session Folder, then lets owners of Session-bound data (Tasks, Harness Sessions) clean up. */
export async function deleteSession(id: string): Promise<void> {
  assertSessionId(id)
  const deleted = await serializeSession(id, async () => {
    const read = await readSessionFile(id)
    await removeSessionFolder(id)
    return read.status === 'ok' ? read.file : null
  })
  for (const listener of deletedListeners) await listener(id, deleted)
}

export function onSessionDeleted(listener: SessionDeletedListener): () => void {
  deletedListeners.add(listener)
  return () => deletedListeners.delete(listener)
}

export async function wipeDemoSessions(): Promise<void> {
  await wipeDemoSessionFolders()
}

export function resetSessionsForTest(): void {
  deletedListeners.clear()
  resetSessionFilesForTest()
  resetSessionGroupsFileForTest()
}
