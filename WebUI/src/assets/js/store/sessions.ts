import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { connectKernelEventStream } from '@/assets/js/projection/kernelProjection'
import { useErrors } from '@/assets/js/store/errors'
import { requestMissingWorkspace } from '@/assets/js/permissions/permissions'
import type {
  MissingWorkspace,
  SessionDeletePreview,
  SessionDocument,
  SessionFolderList,
  SessionGroup,
  SessionGroupsState,
  SessionLastPreset,
  SessionSummary,
  SessionTurn,
  SessionTurns,
  ShowMore,
  ShowMoreSection,
} from '@/types/sessionIpc'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { workspaceEntryOf, type MountedFolderRefusal } from '@/lib/mountedFolders'
import type { MountedFolderAccess } from '@/types/agentSessionIpc'
import { groupToRevealOnOpen } from '@/lib/sessionSections'
import type { GroupNameProblem } from '@/lib/sessionGroupName'
import type { MediaTurnData } from '@/types/sessionTimeline'

/** A panel run submitted in a Session whose turn has not settled into its timeline yet. */
export type PendingMediaTurn = {
  runId: string
  mode: MediaTurnData['mode']
  preset: string
  prompt: string
  inputImageUrl?: string
  createdAt: number
  size?: { width: number; height: number }
  batchSize?: number
}

type IpcResult<T> = ({ success: true } & T) | { success: false; error: string }

function timelineIdOf(message: unknown): string {
  return (message as { id?: string }).id ?? ''
}

function timelineWithout(timeline: unknown[], ids: ReadonlySet<string>): unknown[] {
  return timeline.filter((message) => !ids.has(timelineIdOf(message)))
}

/** Why main would not take a Group name; `problem` is set when a name rule was broken. */
export type GroupNameRefusal = { problem?: GroupNameProblem; error: string }

export type NewSessionOptions = { groupId?: string; settingsFrom?: string }

/** The renderer's projection of the Session module: the Sessions panel rows and the open Session. */
export const useSessions = defineStore('sessions', () => {
  const errors = useErrors()

  const sessions = ref<Record<string, SessionSummary>>({})
  const groups = ref<SessionGroup[]>([])
  const showMore = ref<ShowMore>({ pinned: false, older: false })
  const openSessionId = ref<string | null>(null)
  const openTimeline = ref<unknown[]>([])
  // Ids a regenerate dropped from the view before main's file did; a stale `session-changed` must not restore them.
  const forgottenTimelineIds = new Set<string>()
  /** Artifact URLs of the open Session whose file was deleted; their cards say so. */
  const openDeletedFiles = ref<string[]>([])
  const pendingTurns = ref<Record<string, PendingMediaTurn>>({})

  const orderedSessions = computed(() =>
    Object.values(sessions.value).sort(
      (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
    ),
  )

  const openSession = computed(() =>
    openSessionId.value ? (sessions.value[openSessionId.value] ?? null) : null,
  )

  async function call<T>(
    code: string,
    run: () => Promise<IpcResult<T>>,
  ): Promise<({ success: true } & T) | null> {
    try {
      const result = await run()
      if (result.success) return result
      errors.report(new Error(result.error), { code, category: 'backend', surface: 'toast' })
    } catch (error) {
      errors.report(error, { code, category: 'backend', surface: 'toast' })
    }
    return null
  }

  function remember(session: SessionSummary): void {
    sessions.value = { ...sessions.value, [session.id]: session }
  }

  function applyChanged(document: SessionDocument): void {
    const { timeline, ...summary } = document
    remember(summary)
    if (openSessionId.value !== document.id) return
    openHiddenIds.value = summary.hiddenMessageIds
    const stored = new Set(timeline.map(timelineIdOf))
    for (const id of forgottenTimelineIds) {
      if (!stored.has(id)) forgottenTimelineIds.delete(id)
    }
    openTimeline.value = forgottenTimelineIds.size
      ? timelineWithout(timeline, forgottenTimelineIds)
      : timeline
    refreshDeletedFiles(document.id)
  }

  function applyGroups(state: SessionGroupsState): void {
    groups.value = state.groups
    showMore.value = state.showMore
  }

  /** Each Session's turn in flight, as main's ledger has it. */
  const turns = ref<SessionTurns>({})
  /** Sessions whose turn ended while another was open; cleared when opened. */
  const unseen = ref<Record<string, true>>({})

  function applyTurns(next: SessionTurns): void {
    const ended = Object.keys(turns.value).filter(
      (id) => !next[id] && id !== openSessionId.value && sessions.value[id],
    )
    turns.value = next
    if (ended.length === 0) return
    unseen.value = { ...unseen.value, ...Object.fromEntries(ended.map((id) => [id, true])) }
  }

  const projection = connectKernelEventStream(
    (event) => {
      if (event.type === 'session-changed') applyChanged(event.session)
      if (event.type === 'session-groups-changed') applyGroups(event.state)
      if (event.type === 'session-turns') applyTurns(event.turns)
    },
    (snapshot) => {
      turns.value = { ...snapshot.state.sessionTurns }
    },
  )

  const openTurn = computed<SessionTurn | null>(() =>
    openSessionId.value ? (turns.value[openSessionId.value] ?? null) : null,
  )

  watch(openSessionId, (id) => {
    if (!id || !unseen.value[id]) return
    const { [id]: _seen, ...rest } = unseen.value
    unseen.value = rest
  })
  projection.ready.catch((error: unknown) => errors.report(error, { surface: 'silent' }))
  if (import.meta.hot) {
    import.meta.hot.dispose(() => projection.dispose())
  }

  /** The open Session, creating one when none is open yet. */
  async function ensureOpenSession(): Promise<string | null> {
    return openSessionId.value ?? (await create())
  }

  /** Timeline message ids the user hid in the open Session; the view leaves them out. */
  const openHiddenIds = ref<string[]>([])

  const openVisibleTimeline = computed(() =>
    openHiddenIds.value.length === 0
      ? openTimeline.value
      : timelineWithout(openTimeline.value, new Set(openHiddenIds.value)),
  )

  /** How many Sessions — not just the open one — have a hidden message. */
  const sessionsWithHiddenMessages = computed(
    () =>
      Object.values(sessions.value).filter((session) => session.hiddenMessageIds.length > 0).length,
  )

  /** Hides messages of the open Session: they stay in the file, only the view leaves them out. */
  async function hideTimelineMessages(id: string, messageIds: string[]): Promise<void> {
    if (id !== openSessionId.value) return
    const before = openHiddenIds.value
    openHiddenIds.value = [...new Set([...before, ...messageIds])]
    const result = await call('sessions/hide-failed', () =>
      window.electronAPI.sessions.addHiddenMessages(id, messageIds),
    )
    if (!result) openHiddenIds.value = before
  }

  /** Brings every hidden message of one Session back; its row follows main's change. */
  async function unhideSessionMessages(id: string): Promise<void> {
    const isOpen = id === openSessionId.value
    if (isOpen) openHiddenIds.value = []
    const result = await call('sessions/unhide-failed', () =>
      window.electronAPI.sessions.clearHiddenMessages(id),
    )
    if (!result && isOpen && id === openSessionId.value) await open(id, { reveal: false })
  }

  /** Brings every hidden message of every Session back into its view. */
  async function unhideAllMessages(): Promise<void> {
    const result = await call('sessions/unhide-all-failed', () =>
      window.electronAPI.sessions.clearAllHiddenMessages(),
    )
    if (result) return
    if (openSessionId.value) await open(openSessionId.value, { reveal: false })
  }

  function isFileDeleted(url: string): boolean {
    return openDeletedFiles.value.includes(url)
  }

  function markFileDeleted(sessionId: string, url: string): void {
    if (openSessionId.value !== sessionId || isFileDeleted(url)) return
    openDeletedFiles.value = [...openDeletedFiles.value, url]
  }

  /**
   * The deleted-files list says which of the open Session's recorded artifacts are gone; it
   * was read when the Session opened. A turn may have re-created one of those files since
   * (a new generation can take a freed name), so every Session change re-reads main's list
   * instead of leaving the new card claiming its file was deleted.
   */
  async function refreshDeletedFiles(sessionId: string): Promise<void> {
    try {
      const result = await window.electronAPI.sessions.missingArtifacts(sessionId)
      if (openSessionId.value !== sessionId || !result.success) return
      openDeletedFiles.value = result.missingFiles
    } catch (error) {
      errors.report(error, {
        code: 'sessions/missing-artifacts-failed',
        category: 'backend',
        surface: 'silent',
      })
    }
  }

  function beginMediaTurn(sessionId: string, turn: PendingMediaTurn): void {
    pendingTurns.value = { ...pendingTurns.value, [sessionId]: turn }
  }

  function endMediaTurn(sessionId: string, runId: string): void {
    if (pendingTurns.value[sessionId]?.runId !== runId) return
    const { [sessionId]: _ended, ...rest } = pendingTurns.value
    pendingTurns.value = rest
  }

  /** Hydrates the list and opens the newest Session, creating none; false when listing failed. */
  async function hydrate(): Promise<boolean> {
    const result = await call('sessions/list-failed', () => window.electronAPI.sessions.list())
    if (!result) return false
    sessions.value = Object.fromEntries(result.sessions.map((session) => [session.id, session]))
    applyGroups(result)
    const newest = orderedSessions.value[0]
    if (newest) await open(newest.id, { reveal: false })
    return true
  }

  /** Hydrates the list and opens the newest Session, creating one when there is none. */
  async function init(): Promise<void> {
    if (await hydrate()) await ensureOpenSession()
    // A folder renamed or unplugged while the app was in the background shows up on return.
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('focus', () => {
        const id = openSessionId.value
        if (id && mayGoMissing(id)) void checkWorkspace(id)
      })
    }
  }

  async function openNewestOrCreate(): Promise<void> {
    const newest = orderedSessions.value[0]
    if (newest) await open(newest.id, { reveal: false })
    else await create()
  }

  // Assistant's default capabilities live in the agent store, which already depends on this one.
  let readDefaultCapabilities: () => string[] | undefined = () => undefined

  function provideDefaultCapabilities(read: () => string[]): void {
    readDefaultCapabilities = read
  }

  async function create(options: NewSessionOptions = {}): Promise<string | null> {
    const { groupId, settingsFrom } = options
    const result = await call('sessions/create-failed', () =>
      window.electronAPI.sessions.create(groupId, {
        defaultCapabilities: readDefaultCapabilities(),
        settingsFrom,
      }),
    )
    if (!result) return null
    remember(result.session)
    openSessionId.value = result.session.id
    openTimeline.value = []
    openHiddenIds.value = []
    openDeletedFiles.value = []
    revealInGroup(result.session)
    return result.session.id
  }

  /** A new Reachable Session for a Channel, never opened here; throws with main's reason. */
  async function createReachable(defaultCapabilities: string[]): Promise<string> {
    const created = await window.electronAPI.sessions.create(undefined, { defaultCapabilities })
    if (!created.success) throw new Error(created.error)
    remember(created.session)
    return created.session.id
  }

  /** Opens a Session; resolves with the preset and variant of its last turn. */
  async function open(
    id: string,
    { reveal = true }: { reveal?: boolean } = {},
  ): Promise<SessionLastPreset | null> {
    const result = await call('sessions/open-failed', () => window.electronAPI.sessions.open(id))
    if (!result) return null
    const { timeline, ...summary } = result.session
    remember(summary)
    openSessionId.value = id
    forgottenTimelineIds.clear()
    openTimeline.value = timeline
    openHiddenIds.value = summary.hiddenMessageIds
    openDeletedFiles.value = result.missingFiles
    if (reveal) revealInGroup(summary)
    return result.lastPreset
  }

  async function rename(id: string, title: string): Promise<void> {
    const result = await call('sessions/rename-failed', () =>
      window.electronAPI.sessions.rename(id, title),
    )
    if (result) remember(result.session)
  }

  /** `defaultCapabilities` are Assistant's, for a Session whose settings name none; false when refused. */
  async function setReachable(
    id: string,
    reachable: boolean,
    defaultCapabilities?: string[],
  ): Promise<boolean> {
    const result = await call('sessions/set-reachable-failed', () =>
      window.electronAPI.sessions.setReachable(id, reachable, { defaultCapabilities }),
    )
    if (result) remember(result.session)
    return !!result
  }

  /** The Agent picked in the Session's prompt bar, `null` for Assistant; false when not kept. */
  async function pickAgent(id: string, agentId: string | null): Promise<boolean> {
    const session = sessions.value[id]
    if (session && (session.pickedAgentId ?? null) === agentId) return true
    const result = await call('sessions/pick-agent-failed', () =>
      window.electronAPI.sessions.pickAgent(id, agentId),
    )
    if (result) remember(result.session)
    return !!result
  }

  async function setPinned(id: string, pinned: boolean): Promise<void> {
    const result = await call('sessions/pin-failed', () =>
      window.electronAPI.sessions.pin(id, pinned),
    )
    if (result) remember(result.session)
  }

  function rememberFolders(id: string, folderList: SessionFolderList): void {
    const session = sessions.value[id]
    if (session) remember({ ...session, folderList })
  }

  /** Adds a folder to the Session's list; the refusal is the caller's to show. */
  async function addFolder(
    id: string,
    hostPath: string,
  ): Promise<MountedFolderRefusal | undefined> {
    const result = await call('sessions/add-folder-failed', () =>
      window.electronAPI.sessions.addFolder(id, hostPath),
    )
    if (!result) return undefined
    rememberFolders(id, result.list)
    return result.refusal
  }

  async function removeFolder(id: string, folderId: string): Promise<void> {
    const result = await call('sessions/remove-folder-failed', () =>
      window.electronAPI.sessions.removeFolder(id, folderId),
    )
    if (result) rememberFolders(id, result.list)
  }

  async function setFolderAccess(
    id: string,
    folderId: string,
    access: MountedFolderAccess,
  ): Promise<void> {
    const result = await call('sessions/folder-access-failed', () =>
      window.electronAPI.sessions.setFolderAccess(id, folderId, access),
    )
    if (result) rememberFolders(id, result.list)
  }

  /** Stars a listed folder as the Workspace; whether it had to become read-write, null on failure. */
  async function starFolder(
    id: string,
    folderId: string,
  ): Promise<{ madeReadWrite: boolean } | null> {
    const result = await call('sessions/star-folder-failed', () =>
      window.electronAPI.sessions.starFolder(id, folderId),
    )
    if (!result) return null
    rememberFolders(id, result.list)
    return { madeReadWrite: result.madeReadWrite }
  }

  /** Sessions whose Workspace is a user folder that no longer exists, as last checked. */
  const missingWorkspaces = ref<Record<string, MissingWorkspace>>({})

  const openMissingWorkspace = computed(() =>
    openSessionId.value ? (missingWorkspaces.value[openSessionId.value] ?? null) : null,
  )

  function noteMissing(id: string, missing: MissingWorkspace | null): void {
    const { [id]: _was, ...rest } = missingWorkspaces.value
    missingWorkspaces.value = missing ? { ...rest, [id]: missing } : rest
  }

  /** Checks on disk whether the Session's Workspace is missing. */
  async function checkWorkspace(id: string): Promise<MissingWorkspace | null> {
    const result = await call('sessions/check-workspace-failed', () =>
      window.electronAPI.sessions.missingWorkspace(id),
    )
    const missing = result?.missing ?? null
    noteMissing(id, missing)
    return missing
  }

  /**
   * Lets the user pick the moved folder: 'located', 'cancelled' (no folder picked, or the call
   * failed and was reported), or why the picked folder cannot be the Workspace.
   */
  async function locateWorkspace(
    id: string,
  ): Promise<'located' | 'cancelled' | MountedFolderRefusal> {
    let hostPath: string | undefined
    try {
      const picked = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] })
      hostPath = picked.canceled ? undefined : picked.filePaths[0]
    } catch (error) {
      errors.report(error, { code: 'sessions/locate-workspace-failed', surface: 'toast' })
    }
    if (!hostPath) return 'cancelled'
    const result = await call('sessions/locate-workspace-failed', () =>
      window.electronAPI.sessions.locateWorkspace(id, hostPath),
    )
    if (!result) return 'cancelled'
    rememberFolders(id, result.list)
    if (result.refusal) return result.refusal
    return (await checkWorkspace(id)) === null ? 'located' : 'cancelled'
  }

  async function startNewWorkspace(id: string): Promise<boolean> {
    const result = await call('sessions/start-new-workspace-failed', () =>
      window.electronAPI.sessions.startNewWorkspace(id),
    )
    if (!result) return false
    rememberFolders(id, result.list)
    noteMissing(id, null)
    return true
  }

  /**
   * Before an interactive turn that writes: a missing Workspace is asked about, and the turn
   * goes ahead only once the user located it or started a new one. A refused folder is asked
   * about again, with the reason.
   */
  async function readyWorkspaceForTurn(id: string): Promise<boolean> {
    if (!mayGoMissing(id)) return true
    const missing = await checkWorkspace(id)
    if (!missing) return true
    let refusal: MountedFolderRefusal | undefined
    for (;;) {
      const choice = await requestMissingWorkspace({ missing, refusal })
      if (choice === 'start-new') return startNewWorkspace(id)
      if (choice !== 'locate') return false
      const located = await locateWorkspace(id)
      if (located === 'located') return true
      refusal = located === 'cancelled' ? undefined : located
    }
  }

  /** Only a user folder can go missing: the app makes its own Workspace when it is not there. */
  function mayGoMissing(id: string): boolean {
    const list = sessions.value[id]?.folderList
    const entry = list && workspaceEntryOf(list)
    return !!entry && !entry.appCreated
  }

  /** The Session's Workspace folder as last projected; empty when unknown. */
  function workspaceDirOf(id: string): string {
    const list = sessions.value[id]?.folderList
    return (list && workspaceEntryOf(list)?.hostPath) ?? ''
  }

  watch(
    () => {
      const list = openSession.value?.folderList
      return [openSessionId.value, list && workspaceEntryOf(list)?.hostPath] as const
    },
    ([id]) => {
      if (!id) return
      if (mayGoMissing(id)) void checkWorkspace(id)
      else noteMissing(id, null)
    },
  )

  /** Shows a listed folder in the OS file manager, the Workspace when none is named. */
  async function openFolder(id: string, folderId?: string): Promise<void> {
    await call('sessions/open-folder-failed', () =>
      window.electronAPI.sessions.openFolder(id, folderId),
    )
  }

  /** A refused name is the caller's to show, so it is reported but not toasted. */
  async function nameCall<T>(
    code: string,
    run: () => Promise<
      IpcResult<T> | { success: false; error: string; nameProblem?: GroupNameProblem }
    >,
  ): Promise<({ success: true } & T) | GroupNameRefusal> {
    try {
      const result = await run()
      if (result.success) return result
      errors.report(new Error(result.error), { code, category: 'backend', surface: 'inline' })
      return 'nameProblem' in result && result.nameProblem
        ? { problem: result.nameProblem, error: result.error }
        : { error: result.error }
    } catch (error) {
      errors.report(error, { code, category: 'backend', surface: 'inline' })
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  async function createGroup(id: string, name: string): Promise<GroupNameRefusal | null> {
    const result = await nameCall('sessions/create-group-failed', () =>
      window.electronAPI.sessions.createGroup(id, name),
    )
    if (!('success' in result)) return result
    if (!groups.value.some((group) => group.id === result.group.id)) {
      groups.value = [...groups.value, result.group]
    }
    remember(result.session)
    return null
  }

  /** `null` takes the Session out of its Session Group. */
  async function moveToGroup(id: string, groupId: string | null): Promise<void> {
    const result = await call('sessions/move-to-group-failed', () =>
      window.electronAPI.sessions.moveToGroup(id, groupId),
    )
    if (result) remember(result.session)
  }

  function rememberGroup(group: SessionGroup): void {
    groups.value = groups.value.map((known) => (known.id === group.id ? group : known))
  }

  async function renameGroup(groupId: string, name: string): Promise<GroupNameRefusal | null> {
    const result = await nameCall('sessions/rename-group-failed', () =>
      window.electronAPI.sessions.renameGroup(groupId, name),
    )
    if (!('success' in result)) return result
    rememberGroup(result.group)
    return null
  }

  /** Its Sessions stay; each arrives ungrouped as its own `session-changed`. */
  async function deleteGroup(groupId: string): Promise<void> {
    const result = await call('sessions/delete-group-failed', () =>
      window.electronAPI.sessions.deleteGroup(groupId),
    )
    if (result) groups.value = groups.value.filter((group) => group.id !== groupId)
  }

  function revealInGroup(session: SessionSummary): void {
    const groupId = groupToRevealOnOpen(session, groups.value)
    if (groupId) void setGroupExpanded(groupId, true)
  }

  async function setGroupExpanded(groupId: string, expanded: boolean): Promise<void> {
    const group = groups.value.find((known) => known.id === groupId)
    if (!group) return
    rememberGroup({ ...group, expanded })
    const result = await call('sessions/expand-group-failed', () =>
      window.electronAPI.sessions.setGroupExpanded(groupId, expanded),
    )
    rememberGroup(result ? result.group : group)
  }

  async function setShowMore(section: ShowMoreSection, shown: boolean): Promise<void> {
    showMore.value = { ...showMore.value, [section]: shown }
    const result = await call('sessions/show-more-failed', () =>
      window.electronAPI.sessions.setShowMore(section, shown),
    )
    if (!result) showMore.value = { ...showMore.value, [section]: !shown }
  }

  /** Saves settled display messages into a Session's timeline; one with a known id is replaced. */
  async function saveTimelineMessages(id: string, messages: { id: string }[]): Promise<void> {
    let saved = messages
    if (id === openSessionId.value) {
      const timeline = [...openTimeline.value]
      const at = new Map(timeline.map((message, index) => [timelineIdOf(message), index]))
      saved = messages.map((message) => {
        const index = at.get(message.id)
        if (index === undefined) {
          timeline.push(message)
          return message
        }
        // A message's createdAt is when it first settled: a replace never moves
        // it, and never stamps a message that had none — a fresh settle time
        // is only honest for a message's first arrival, which is a push.
        const prior = (timeline[index] as { createdAt?: number }).createdAt
        const merged = { ...message, createdAt: prior }
        timeline[index] = merged
        return merged
      })
      openTimeline.value = timeline
    }
    await call('sessions/save-timeline-failed', () =>
      window.electronAPI.sessions.saveTimelineMessages(id, cloneForIpc(saved)),
    )
  }

  /** Takes messages out of the open timeline: main's copy follows, or already went. */
  function forgetTimelineMessages(id: string, messageIds: string[]): void {
    if (id !== openSessionId.value) return
    for (const messageId of messageIds) forgottenTimelineIds.add(messageId)
    openTimeline.value = timelineWithout(openTimeline.value, forgottenTimelineIds)
  }

  /** Takes messages out of a Session's timeline in its file; the open view follows. */
  async function removeTimelineMessages(id: string, messageIds: string[]): Promise<void> {
    const result = await call('sessions/remove-timeline-failed', () =>
      window.electronAPI.sessions.removeTimelineMessages(id, messageIds),
    )
    if (result) forgetTimelineMessages(id, messageIds)
  }

  /** Brings back what a premature forget removed; main never took them out of the file. */
  async function restoreForgottenTimelineMessages(id: string): Promise<void> {
    if (id !== openSessionId.value) return
    forgottenTimelineIds.clear()
    await open(id, { reveal: false })
  }

  /** What the delete dialog names; null when it cannot be read, and the dialog says less. */
  async function deletePreview(id: string): Promise<SessionDeletePreview | null> {
    const result = await call('sessions/delete-preview-failed', () =>
      window.electronAPI.sessions.deletePreview(id),
    )
    return result?.preview ?? null
  }

  async function remove(id: string): Promise<void> {
    const result = await call('sessions/delete-failed', () =>
      window.electronAPI.sessions.delete(id),
    )
    if (!result) return
    const { [id]: _removed, ...rest } = sessions.value
    sessions.value = rest
    if (openSessionId.value !== id) return
    openSessionId.value = null
    forgottenTimelineIds.clear()
    openTimeline.value = []
    openHiddenIds.value = []
    openDeletedFiles.value = []
    await openNewestOrCreate()
  }

  return {
    sessions,
    groups,
    showMore,
    openSessionId,
    openTimeline,
    openHiddenIds,
    openVisibleTimeline,
    sessionsWithHiddenMessages,
    openDeletedFiles,
    pendingTurns,
    turns,
    unseen,
    openTurn,
    orderedSessions,
    openSession,
    init,
    hydrate,
    create,
    createReachable,
    provideDefaultCapabilities,
    open,
    rename,
    setPinned,
    addFolder,
    removeFolder,
    setFolderAccess,
    starFolder,
    openFolder,
    missingWorkspaces,
    openMissingWorkspace,
    checkWorkspace,
    locateWorkspace,
    startNewWorkspace,
    readyWorkspaceForTurn,
    workspaceDirOf,
    pickAgent,
    setReachable,
    createGroup,
    moveToGroup,
    renameGroup,
    deleteGroup,
    setGroupExpanded,
    setShowMore,
    remove,
    deletePreview,
    saveTimelineMessages,
    forgetTimelineMessages,
    removeTimelineMessages,
    hideTimelineMessages,
    unhideSessionMessages,
    unhideAllMessages,
    restoreForgottenTimelineMessages,
    ensureOpenSession,
    isFileDeleted,
    markFileDeleted,
    beginMediaTurn,
    endMediaTurn,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessions, import.meta.hot))
}
