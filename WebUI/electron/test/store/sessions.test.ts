import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The Sessions store driven against the real Session module in a temp dir, so
// what the panel shows is what is on disk.

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/assets/js/toast', () => ({
  show: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}))

const sessionModule = await import('../../session/sessions')
const kernelBus = await import('../../kernel/kernelBus')
const { recordMediaTurn } = await import('../../session/sessionMediaTurn')
const { appendHistoryEntry, historyOverviewUpdates } = await import('../../session/sessionHistory')
const {
  addHiddenMessages,
  clearAllHiddenMessages,
  clearHiddenMessages,
  removeTimelineMessages,
  upsertTimelineMessages,
} = await import('../../session/sessionTimeline')
const { readSessionSettings } = await import('../../session/sessionSettings')
const { useSessions } = await import('@/assets/js/store/sessions')
const ledger = await import('../../session/sessionTurns')
const { buildSessionsRegistry } = await import('../../kernel/registries/sessions')
type SessionsDeps = import('../../kernel/registries/sessions').SessionsDeps

const sessionFolders = await import('../../session/sessionFolders')
const sessionWorkspace = await import('../../session/sessionWorkspace')
const { missingArtifactUrls } = await import('../../session/sessionArtifacts')
const { sessionFolderMediaFile } = await import('../../session/sessionFolderMedia')
const { useDialogStore } = await import('@/assets/js/store/dialogs')

const registry = buildSessionsRegistry({
  ...sessionModule,
  ...sessionFolders,
  ...sessionWorkspace,
  addHiddenMessages,
  clearHiddenMessages,
  clearAllHiddenMessages,
  historyOverviewUpdates,
} as unknown as SessionsDeps)
/** The folder the next "Locate folder…" picker returns; undefined cancels it. */
let pickedFolder: string | undefined
const noEvent = {} as never
const idsOf = (timeline: unknown[]) => timeline.map((message) => (message as { id?: string }).id)

function ok<T extends object>(run: () => Promise<T>) {
  return async () => ({ success: true as const, ...(await run()) })
}

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-sessions-store-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  sessionModule.setSessionDeps({ isDemoMode: () => false })
  kernelBus.resetKernelBusForTest()
  ledger.resetSessionTurnsForTest()
  vi.stubGlobal('window', {
    electronAPI: {
      onKernelEvent: kernelBus.onKernelEvent,
      getKernelSnapshot: async () => kernelBus.getKernelSnapshot(),
      sessions: {
        list: ok(async () => ({
          sessions: await sessionModule.listSessions(),
          groups: await sessionModule.listSessionGroups(),
          showMore: await sessionModule.readShowMore(),
        })),
        create: (groupId?: string, options?: { defaultCapabilities?: string[] }) =>
          ok(async () => ({ session: await sessionModule.createSession(groupId, options) }))(),
        open: (id: string) =>
          ok(async () => ({
            session: await sessionModule.openSession(id),
            missingFiles: await missingArtifactUrls(id),
          }))(),
        missingArtifacts: (id: string) =>
          ok(async () => ({ missingFiles: await missingArtifactUrls(id) }))(),
        rename: (id: string, title: string) =>
          ok(async () => ({ session: await sessionModule.renameSession(id, title) }))(),
        delete: (id: string) => ok(async () => sessionModule.deleteSession(id).then(() => ({})))(),
        setIncludedInOverviews: (
          id: string,
          included: boolean,
          request?: import('@/types/sessionIpc').OverviewSummaryRequest,
        ) => registry['sessions:setIncludedInOverviews'](noEvent, id, included, request),
        overviewUpdates: (id: string) => registry['sessions:overviewUpdates'](noEvent, id),
        createGroup: (id: string, name: string) =>
          registry['sessions:createGroup'](noEvent, id, name),
        renameGroup: (groupId: string, name: string) =>
          registry['sessions:renameGroup'](noEvent, groupId, name),
        setGroupExpanded: (groupId: string, expanded: boolean) =>
          registry['sessions:setGroupExpanded'](noEvent, groupId, expanded),
        setShowMore: (section: 'pinned' | 'older', shown: boolean) =>
          registry['sessions:setShowMore'](noEvent, section, shown),
        addHiddenMessages: (id: string, messageIds: string[]) =>
          registry['sessions:addHiddenMessages'](noEvent, id, messageIds),
        clearHiddenMessages: (id: string) => registry['sessions:clearHiddenMessages'](noEvent, id),
        clearAllHiddenMessages: () => registry['sessions:clearAllHiddenMessages'](noEvent),
        missingWorkspace: (id: string) => registry['sessions:missingWorkspace'](noEvent, id),
        locateWorkspace: (id: string, hostPath: string) =>
          registry['sessions:locateWorkspace'](noEvent, id, hostPath),
        startNewWorkspace: (id: string) => registry['sessions:startNewWorkspace'](noEvent, id),
      },
      showOpenDialog: async () =>
        pickedFolder
          ? { canceled: false, filePaths: [pickedFolder] }
          : { canceled: true, filePaths: [] },
    },
  })
  setActivePinia(createPinia())
})

afterEach(async () => {
  vi.unstubAllGlobals()
  sessionModule.resetSessionsForTest()
  await fs.rm(path.dirname(dirs.real), { recursive: true, force: true })
})

describe('Sessions store', () => {
  it('opens a fresh Session on first boot', async () => {
    const store = useSessions()

    await store.init()

    const onDisk = await sessionModule.listSessions()
    expect(onDisk).toHaveLength(1)
    expect(store.openSessionId).toBe(onDisk[0].id)
  })

  it('reopens the most recent Session on a later boot', async () => {
    await sessionModule.createSession()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const newest = await sessionModule.createSession()
    const store = useSessions()

    await store.init()

    expect(store.openSessionId).toBe(newest.id)
    expect(store.orderedSessions).toHaveLength(2)
  })

  it('"+" always creates and opens another Session', async () => {
    const store = useSessions()
    await store.init()
    const first = store.openSessionId

    await store.create()

    expect(store.openSessionId).not.toBe(first)
    expect(await sessionModule.listSessions()).toHaveLength(2)
  })

  it("creates a Reachable Session whose Assistant can notify, from Assistant's defaults", async () => {
    const store = useSessions()
    store.provideDefaultCapabilities(() => ['web'])
    await store.init()

    const id = (await store.create())!

    expect(store.sessions[id].reachable).toBe(true)
    const settings = await readSessionSettings(id)
    expect(settings.Assistant.bags.Assistant.values.capabilities).toEqual(['web', 'notify'])
  })

  it("leaves first boot's Session to be created once Assistant's defaults are known", async () => {
    const store = useSessions()

    await store.hydrate()
    expect(await sessionModule.listSessions()).toEqual([])
    expect(store.openSessionId).toBeNull()

    store.provideDefaultCapabilities(() => ['rag'])
    const id = await store.ensureOpenSession()

    expect(store.openSessionId).toBe(id)
    const settings = await readSessionSettings(id!)
    expect(settings.Assistant.bags.Assistant.values.capabilities).toEqual(['rag', 'notify'])
  })

  it('hydrating reopens the most recent Session, creating none', async () => {
    const existing = await sessionModule.createSession()
    const store = useSessions()

    await store.hydrate()

    expect(store.openSessionId).toBe(existing.id)
    expect(await sessionModule.listSessions()).toHaveLength(1)
  })

  it('creates a Channel Session reachable in one call, without opening it', async () => {
    const store = useSessions()
    await store.init()
    const open = store.openSessionId

    const id = await store.createReachable(['rag'])

    expect(store.sessions[id].reachable).toBe(true)
    expect(store.openSessionId).toBe(open)
    const settings = await readSessionSettings(id)
    expect(settings.Assistant.bags.Assistant.values.capabilities).toEqual(['rag', 'notify'])
  })

  it('shows a renamed title', async () => {
    const store = useSessions()
    await store.init()

    await store.rename(store.openSessionId!, 'Holiday cards')

    expect(store.openSession?.title).toBe('Holiday cards')
  })

  it('sees a Session pinned or unpinned in main through the Session-changed push', async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!

    await sessionModule.pinSession(id, true)
    await vi.waitFor(() => expect(store.openSession?.pinned).toBe(true))

    await sessionModule.pinSession(id, false)
    await vi.waitFor(() => expect(store.openSession?.pinned).toBe(false))
  })

  it('sees a Session renamed or cleared in main through the Session-changed push', async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!

    await sessionModule.renameSession(id, 'Holiday cards')
    await vi.waitFor(() => expect(store.openSession?.title).toBe('Holiday cards'))

    await sessionModule.renameSession(id, '')
    await vi.waitFor(() => expect(store.openSession).toMatchObject({ title: '', renamed: false }))
  })

  it('moves to another Session when the open one is deleted', async () => {
    const store = useSessions()
    await store.init()
    const kept = store.openSessionId!
    const doomed = (await store.create())!

    await store.remove(doomed)

    expect(store.openSessionId).toBe(kept)
    expect((await sessionModule.listSessions()).map((session) => session.id)).toEqual([kept])
  })

  it('starts a new Session when the last one is deleted', async () => {
    const store = useSessions()
    await store.init()
    const only = store.openSessionId!

    await store.remove(only)

    expect(store.openSessionId).not.toBe(only)
    expect(store.orderedSessions.map((session) => session.id)).toEqual([store.openSessionId])
  })

  it('shows a media turn that settled into the open Session', async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!

    await recordMediaTurn({
      sessionId: id,
      runId: 'run-1',
      mode: 'imageGen',
      preset: 'Dummy Image (test)',
      prompt: 'a red fox',
      status: 'failed',
      items: [],
      localPathOf: () => null,
    })

    await vi.waitFor(() => expect(store.openTimeline).toHaveLength(2))
    expect(store.sessions[id]).toMatchObject({
      title: 'a red fox',
      presetsUsed: ['Dummy Image (test)'],
    })
  })

  it('clears a card’s deleted notice when a later change re-creates its file', async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!
    const media = path.join(path.dirname(dirs.real), 'media')
    await fs.mkdir(media)
    await fs.writeFile(path.join(media, 'apple.png'), 'first apple')

    const [item] = await recordMediaTurn({
      sessionId: id,
      runId: 'run-1',
      mode: 'imageGen',
      preset: 'Dummy Image (test)',
      prompt: 'an apple',
      status: 'completed',
      items: [
        {
          id: 'i1',
          mode: 'imageGen',
          state: 'done',
          type: 'image',
          imageUrl: 'aipg-media://media/apple.png',
          settings: { preset: 'Dummy Image (test)', prompt: 'an apple' },
          dynamicSettings: [],
          createdAt: 1,
        } as never,
      ],
      localPathOf: (url) =>
        url === 'aipg-media://media/apple.png' ? path.join(media, 'apple.png') : null,
    })
    const url = (item as { imageUrl: string }).imageUrl
    expect(sessionFolderMediaFile(url)).not.toBeNull()

    // The file was deleted: opening the Session again shows its card as deleted.
    await fs.rm(sessionFolderMediaFile(url)!)
    await store.open(id)
    expect(store.isFileDeleted(url)).toBe(true)

    // A later generation re-created the file: the Session change re-reads the list, so
    // the new card stops claiming its file was deleted.
    await fs.writeFile(sessionFolderMediaFile(url)!, 'second apple')
    await sessionModule.renameSession(id, 're-created')
    await vi.waitFor(() => expect(store.isFileDeleted(url)).toBe(false))

    // A file that is really gone stays flagged after a change.
    await fs.rm(sessionFolderMediaFile(url)!)
    await sessionModule.renameSession(id, 'deleted again')
    await vi.waitFor(() => expect(store.isFileDeleted(url)).toBe(true))
  })

  it('keeps a prematurely forgotten message out while the file still holds it, and dissolves the forget once the file drops it', async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!
    const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }
    const answer = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'working' }] }
    await upsertTimelineMessages(id, [user, answer])
    await sessionModule.renameSession(id, 'seeded')
    await vi.waitFor(() => expect(idsOf(store.openTimeline)).toEqual(['u1', 'a1']))

    store.forgetTimelineMessages(id, ['a1'])
    expect(idsOf(store.openTimeline)).toEqual(['u1'])

    // The file still holds the message: a later change must not bring it back.
    await sessionModule.renameSession(id, 'regenerating')
    await vi.waitFor(() => expect(store.openSession?.title).toBe('regenerating'))
    expect(idsOf(store.openTimeline)).toEqual(['u1'])

    // Main settled and dropped it: the forget dissolves.
    await removeTimelineMessages(id, ['a1'])
    await sessionModule.renameSession(id, 'settled')
    await vi.waitFor(() => expect(store.openSession?.title).toBe('settled'))
    expect(idsOf(store.openTimeline)).toEqual(['u1'])

    // The forget is truly gone: that id coming back in a document shows again.
    await upsertTimelineMessages(id, [answer])
    await sessionModule.renameSession(id, 'resurfaced')
    await vi.waitFor(() => expect(store.openSession?.title).toBe('resurfaced'))
    expect(idsOf(store.openTimeline)).toEqual(['u1', 'a1'])
  })

  it('brings back what a premature forget removed, from the file that still holds it', async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!
    const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }
    const answer = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'working' }] }
    await upsertTimelineMessages(id, [user, answer])
    await sessionModule.renameSession(id, 'seeded')
    await vi.waitFor(() => expect(idsOf(store.openTimeline)).toEqual(['u1', 'a1']))

    store.forgetTimelineMessages(id, ['a1'])
    expect(idsOf(store.openTimeline)).toEqual(['u1'])

    await store.restoreForgottenTimelineMessages(id)

    expect(idsOf(store.openTimeline)).toEqual(['u1', 'a1'])
  })

  it('clears the forget when another Session opens', async () => {
    const store = useSessions()
    await store.init()
    const forgotten = store.openSessionId!
    const user = { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }
    const answer = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'working' }] }
    await upsertTimelineMessages(forgotten, [user, answer])
    await sessionModule.renameSession(forgotten, 'seeded')
    await vi.waitFor(() => expect(idsOf(store.openTimeline)).toEqual(['u1', 'a1']))
    store.forgetTimelineMessages(forgotten, ['a1'])

    const other = (await store.create())!

    expect(store.openSessionId).toBe(other)
    await store.open(forgotten)
    expect(idsOf(store.openTimeline)).toEqual(['u1', 'a1'])
  })

  it("knows each Session's turn in flight, and marks one that ended out of sight as unseen", async () => {
    const store = useSessions()
    await store.init()
    const background = store.openSessionId!
    await store.create()
    const open = store.openSessionId!

    ledger.claimSessionTurn(background, { turnId: 'a', kind: 'agent' })
    ledger.claimSessionTurn(open, { turnId: 'b', kind: 'media' })
    await vi.waitFor(() => expect(store.openTurn?.kind).toBe('media'))
    expect(store.turns[background]?.kind).toBe('agent')

    ledger.releaseSessionTurn(background, 'a')
    ledger.releaseSessionTurn(open, 'b')
    await vi.waitFor(() => expect(store.openTurn).toBeNull())
    expect(store.unseen).toEqual({ [background]: true })

    await store.open(background)
    expect(store.unseen).toEqual({})
  })

  it('learns the turns already in flight when it connects', async () => {
    const session = await sessionModule.createSession()
    ledger.claimSessionTurn(session.id, { turnId: 'a', kind: 'chat' })
    const store = useSessions()

    await store.init()

    await vi.waitFor(() => expect(store.openTurn?.kind).toBe('chat'))
  })

  it('marks a Turn Stopping by its id, with when the stop was asked for, until it is released', async () => {
    const store = useSessions()
    await store.init()
    const session = store.openSessionId!
    ledger.claimSessionTurn(session, { turnId: 't1', kind: 'chat' })
    await vi.waitFor(() => expect(store.openTurn?.turnId).toBe('t1'))

    const asked = Date.now()
    store.markTurnStopping('t1')

    expect(store.isTurnStopping('t1')).toBe(true)
    expect(store.stoppingTurns.t1).toBeGreaterThanOrEqual(asked)

    ledger.releaseSessionTurn(session, 't1')
    await vi.waitFor(() => expect(store.openTurn).toBeNull())

    expect(store.isTurnStopping('t1')).toBe(false)
    expect(store.stoppingTurns).toEqual({})
  })

  it.each(['media', 'agent', 'audio'] as const)(
    'marks a stopping %s Turn until it is released',
    async (kind) => {
      const store = useSessions()
      await store.init()
      const session = store.openSessionId!
      const turnId = `${kind}-turn`
      ledger.claimSessionTurn(session, { turnId, kind })
      await vi.waitFor(() => expect(store.openTurn?.turnId).toBe(turnId))

      store.markTurnStopping(turnId)
      expect(store.isTurnStopping(turnId)).toBe(true)

      ledger.releaseSessionTurn(session, turnId)
      await vi.waitFor(() => expect(store.openTurn).toBeNull())

      expect(store.isTurnStopping(turnId)).toBe(false)
    },
  )

  it('tracks Stopping Turns in different Sessions independently', async () => {
    const store = useSessions()
    await store.init()
    const first = store.openSessionId!
    await store.create()
    const second = store.openSessionId!
    ledger.claimSessionTurn(first, { turnId: 't1', kind: 'chat' })
    ledger.claimSessionTurn(second, { turnId: 't2', kind: 'chat' })
    await vi.waitFor(() => expect(store.turns[second]?.turnId).toBe('t2'))

    store.markTurnStopping('t1')
    store.markTurnStopping('t2')
    ledger.releaseSessionTurn(first, 't1')
    await vi.waitFor(() => expect(store.isTurnStopping('t1')).toBe(false))

    expect(store.isTurnStopping('t2')).toBe(true)
  })

  it('ticks one shared clock only while a Turn is Stopping', async () => {
    const store = useSessions()
    await store.init()
    vi.useFakeTimers()
    try {
      const asked = Date.now()
      store.markTurnStopping('t1')
      expect(store.stoppingNow).toBe(asked)

      vi.advanceTimersByTime(5_000)
      expect(store.stoppingNow).toBe(asked + 5_000)

      store.stoppingTurns = {}
      const settled = store.stoppingNow
      vi.advanceTimersByTime(5_000)
      expect(store.stoppingNow).toBe(settled)
    } finally {
      store.stoppingTurns = {}
      vi.useRealTimers()
    }
  })

  it('keeps a stopping Turn across a Session switch', async () => {
    const store = useSessions()
    await store.init()
    const first = store.openSessionId!
    const second = (await store.create())!
    ledger.claimSessionTurn(first, { turnId: 't1', kind: 'chat' })
    await vi.waitFor(() => expect(store.turns[first]?.turnId).toBe('t1'))
    store.markTurnStopping('t1')

    await store.open(second)
    await store.open(first)

    expect(store.isTurnStopping('t1')).toBe(true)
  })

  it('sees Groups renamed, collapsed, deleted and Pinned "show more" through the Groups push', async () => {
    const store = useSessions()
    await store.init()
    const { group } = await sessionModule.createSessionGroup(store.openSessionId!, 'Lisbon')
    await vi.waitFor(() => expect(store.groups).toEqual([group]))

    await sessionModule.renameSessionGroup(group.id, 'Porto')
    await sessionModule.setSessionGroupExpanded(group.id, false)
    await vi.waitFor(() =>
      expect(store.groups).toEqual([{ ...group, name: 'Porto', expanded: false }]),
    )

    await sessionModule.setShowMore('pinned', true)
    await sessionModule.setShowMore('older', true)
    await sessionModule.deleteSessionGroup(group.id)
    await vi.waitFor(() => expect(store.groups).toEqual([]))
    expect(store.showMore).toEqual({ pinned: true, older: true })
  })

  it('shows all of Older at once and reads the choice back on the next boot', async () => {
    const store = useSessions()
    await store.init()

    const saving = store.setShowMore('older', true)
    expect(store.showMore).toEqual({ pinned: false, older: true })
    await saving
    expect(await sessionModule.readShowMore()).toEqual({ pinned: false, older: true })

    setActivePinia(createPinia())
    const rebooted = useSessions()
    await rebooted.init()
    expect(rebooted.showMore).toEqual({ pinned: false, older: true })
  })

  it('folds Older back when main cannot save the choice', async () => {
    const store = useSessions()
    await store.init()
    await fs.writeFile(path.join(dirs.real, 'session-groups.json'), '{not json')

    await store.setShowMore('older', true)

    expect(store.showMore).toEqual({ pinned: false, older: false })
  })

  it("refuses a Group name main finds taken, though this store's list had not seen it", async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!
    const other = await sessionModule.createSession()
    await sessionModule.createSessionGroup(other.id, 'Lisbon')
    store.groups = []

    expect(await store.createGroup(id, 'lisbon')).toMatchObject({ problem: 'taken' })
    expect(store.sessions[id]?.groupId).toBeUndefined()
  })

  it('refuses renaming a Group to a name main finds taken', async () => {
    const store = useSessions()
    await store.init()
    const { group } = await sessionModule.createSessionGroup(store.openSessionId!, 'Lisbon')
    const other = await sessionModule.createSession()
    await sessionModule.createSessionGroup(other.id, 'Porto')

    expect(await store.renameGroup(group.id, 'PORTO')).toMatchObject({ problem: 'taken' })
    expect(await store.renameGroup(group.id, 'Faro')).toBeNull()
  })

  it('expands a collapsed Group when one of its Sessions is opened, and lets it be collapsed again', async () => {
    const store = useSessions()
    await store.init()
    const inside = store.openSessionId!
    const { group } = await sessionModule.createSessionGroup(inside, 'Lisbon')
    await sessionModule.setSessionGroupExpanded(group.id, false)
    await store.create()
    await vi.waitFor(() => expect(store.groups[0]?.expanded).toBe(false))

    await store.open(inside)
    await vi.waitFor(() => expect(store.groups[0]?.expanded).toBe(true))

    await store.setGroupExpanded(group.id, false)
    expect(store.groups[0]?.expanded).toBe(false)
    expect((await sessionModule.listSessionGroups())[0]?.expanded).toBe(false)
  })

  it('keeps a collapsed Group collapsed when its Session is reopened on boot', async () => {
    const first = await sessionModule.createSession()
    const { group } = await sessionModule.createSessionGroup(first.id, 'Lisbon')
    await sessionModule.setSessionGroupExpanded(group.id, false)

    const store = useSessions()
    await store.init()
    expect(store.openSessionId).toBe(first.id)
    expect(store.groups[0]?.expanded).toBe(false)
  })
})

describe('Hidden messages', () => {
  /** Two settled chat turns, `u1`/`a1` then `u2`/`a2`, in the open Session. */
  async function seedTurns(store: ReturnType<typeof useSessions>) {
    const id = store.openSessionId!
    const messages = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'first' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'one' }] },
      { id: 'u2', role: 'user', parts: [{ type: 'text', text: 'second' }] },
      { id: 'a2', role: 'assistant', parts: [{ type: 'text', text: 'two' }] },
    ]
    await upsertTimelineMessages(id, messages)
    await sessionModule.renameSession(id, 'seeded')
    await vi.waitFor(() => expect(idsOf(store.openTimeline)).toEqual(['u1', 'a1', 'u2', 'a2']))
    return id
  }

  it('hides a turn of the open Session: the file keeps it, the view leaves it out', async () => {
    const store = useSessions()
    await store.init()
    const id = await seedTurns(store)

    await store.hideTimelineMessages(id, ['u1', 'a1'])

    expect(idsOf(store.openVisibleTimeline)).toEqual(['u2', 'a2'])
    // The messages stay in the file, and in what the model sees.
    expect(idsOf(store.openTimeline)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect((await sessionModule.openSession(id)).hiddenMessageIds).toEqual(['u1', 'a1'])
  })

  it('keeps saving hidden messages, so nothing is lost or duplicated in the file', async () => {
    const store = useSessions()
    await store.init()
    const id = await seedTurns(store)
    await store.hideTimelineMessages(id, ['u1', 'a1'])

    const updated = { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'one more' }] }
    await store.saveTimelineMessages(id, [updated])

    expect(idsOf(store.openTimeline)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect((await sessionModule.openSession(id)).timeline).toHaveLength(4)
  })

  it("keeps a message's first-settled createdAt, and never stamps an unstamped one", async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!
    const old = { id: 'a1', role: 'assistant', parts: [] } // settled before timestamps existed
    const fresh = { id: 'b1', role: 'assistant', parts: [], createdAt: 1_000 }

    await store.saveTimelineMessages(id, [old, fresh])
    // A later settle re-sends the whole transcript, freshly stamped.
    const oldAgain = { ...old, createdAt: 9_000 }
    const freshAgain = { ...fresh, createdAt: 9_000 }
    await store.saveTimelineMessages(id, [oldAgain, freshAgain])

    const stamps = (store.openTimeline as { createdAt?: number }[]).map(
      (message) => message.createdAt,
    )
    expect(stamps).toEqual([undefined, 1_000])
  })

  it('takes the hidden mark off with the messages a delete removes', async () => {
    const store = useSessions()
    await store.init()
    const id = await seedTurns(store)
    await store.hideTimelineMessages(id, ['u1', 'a1'])

    await removeTimelineMessages(id, ['a1'])
    await sessionModule.renameSession(id, 'settled')

    expect((await sessionModule.openSession(id)).hiddenMessageIds).toEqual(['u1'])
  })

  it('brings the hidden turn of the open Session back', async () => {
    const store = useSessions()
    await store.init()
    const id = await seedTurns(store)
    await store.hideTimelineMessages(id, ['u1', 'a1'])

    await store.unhideSessionMessages(id)

    expect(idsOf(store.openVisibleTimeline)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect((await sessionModule.openSession(id)).hiddenMessageIds).toEqual([])
  })

  it('reads the hidden messages back on a later open', async () => {
    const store = useSessions()
    await store.init()
    const id = await seedTurns(store)
    await store.hideTimelineMessages(id, ['u1', 'a1'])

    await store.create()
    await store.open(id)

    expect(store.openHiddenIds).toEqual(['u1', 'a1'])
    expect(idsOf(store.openVisibleTimeline)).toEqual(['u2', 'a2'])
  })

  it('unhides every Session at once, not just the open one', async () => {
    const store = useSessions()
    await store.init()
    const open = await seedTurns(store)
    const other = (await store.create())!
    const elsewhere = { id: 'u3', role: 'user', parts: [{ type: 'text', text: 'elsewhere' }] }
    const there = { id: 'a3', role: 'assistant', parts: [{ type: 'text', text: 'there' }] }
    await upsertTimelineMessages(other, [elsewhere, there])
    await addHiddenMessages(other, ['u3', 'a3'])
    // The push brings the pair in with its hidden mark: the view shows nothing.
    await vi.waitFor(() => expect(store.openVisibleTimeline).toEqual([]))

    // Hiding a turn of the first Session marks it while that Session is open.
    await store.open(open)
    await vi.waitFor(() => expect(idsOf(store.openTimeline)).toEqual(['u1', 'a1', 'u2', 'a2']))
    await store.hideTimelineMessages(open, ['u2', 'a2'])

    await store.unhideAllMessages()

    expect(idsOf(store.openVisibleTimeline)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect((await sessionModule.openSession(open)).hiddenMessageIds).toEqual([])
    expect((await sessionModule.openSession(other)).hiddenMessageIds).toEqual([])
  })

  it('hides a turn whose messages have not settled into the file yet', async () => {
    const store = useSessions()
    await store.init()
    const id = store.openSessionId!
    await sessionModule.renameSession(id, 'seeded')

    // A live turn hides before its messages are saved; the mark waits for them.
    await store.hideTimelineMessages(id, ['u9', 'a9'])
    expect(store.openHiddenIds).toEqual(['u9', 'a9'])

    const late = { id: 'u9', role: 'user', parts: [{ type: 'text', text: 'late' }] }
    const settled = { id: 'a9', role: 'assistant', parts: [{ type: 'text', text: 'settled' }] }
    await upsertTimelineMessages(id, [late, settled])
    const document = await sessionModule.openSession(id)
    expect(document.hiddenMessageIds).toEqual(['u9', 'a9'])
  })

  it('carries the hidden ids in the Session rows, not just the open Session', async () => {
    const store = useSessions()
    await store.init()
    const id = await seedTurns(store)
    await store.hideTimelineMessages(id, ['u1', 'a1'])

    await vi.waitFor(() => expect(store.sessions[id]?.hiddenMessageIds).toEqual(['u1', 'a1']))
  })

  it('counts the Sessions with hidden messages while another Session is the open one', async () => {
    const store = useSessions()
    await store.init()
    expect(store.sessionsWithHiddenMessages).toBe(0)

    const hidden = store.openSessionId!
    await seedTurns(store)
    await store.hideTimelineMessages(hidden, ['u1', 'a1'])
    await store.create()
    expect(store.openSessionId).not.toBe(hidden)

    // The hidden pair sits in a Session that is no longer open: the rows know it.
    await vi.waitFor(() => expect(store.sessionsWithHiddenMessages).toBe(1))

    await store.unhideAllMessages()
    await vi.waitFor(() => expect(store.sessionsWithHiddenMessages).toBe(0))
  })

  it('unhides a Session that is not the open one, from its row', async () => {
    const store = useSessions()
    await store.init()
    const hidden = await seedTurns(store)
    await store.hideTimelineMessages(hidden, ['u1', 'a1'])
    await store.create()

    await store.unhideSessionMessages(hidden)

    expect((await sessionModule.openSession(hidden)).hiddenMessageIds).toEqual([])
    await vi.waitFor(() => expect(store.sessions[hidden]?.hiddenMessageIds).toEqual([]))
    expect(store.openHiddenIds).toEqual([])
  })
})

describe('a turn in a Session whose Workspace is missing', () => {
  async function missingProject(store: ReturnType<typeof useSessions>) {
    await store.init()
    const id = store.openSessionId!
    const project = path.join(path.dirname(dirs.real), 'Project')
    await fs.mkdir(project)
    const { list } = await sessionFolders.addSessionFolder(id, project)
    await sessionFolders.starSessionFolder(id, list.folders.find((f) => f.hostPath === project)!.id)
    await fs.rm(project, { recursive: true })
    return { id, project }
  }

  async function answerQuestion(choice: 'locate' | 'start-new' | null): Promise<string> {
    const dialogs = useDialogStore()
    await vi.waitFor(() => expect(dialogs.missingWorkspaceQuestion).not.toBeNull())
    const name = dialogs.missingWorkspaceQuestion!.missing.name
    dialogs.missingWorkspaceQuestion!.answer(choice)
    return name
  }

  it('is asked about, and runs in the folder the user located', async () => {
    const store = useSessions()
    const { id, project } = await missingProject(store)
    const moved = path.join(path.dirname(dirs.real), 'Moved')
    await fs.mkdir(moved)
    pickedFolder = moved

    const ready = store.readyWorkspaceForTurn(id)
    expect(await answerQuestion('locate')).toBe('Project')

    expect(await ready).toBe(true)
    expect(store.workspaceDirOf(id)).toBe(moved)
    expect(store.missingWorkspaces[id]).toBeUndefined()
    expect(project).not.toBe(moved)
  })

  it('runs in a fresh app-created Workspace when the user starts a new one', async () => {
    const store = useSessions()
    const { id, project } = await missingProject(store)

    const ready = store.readyWorkspaceForTurn(id)
    await answerQuestion('start-new')

    expect(await ready).toBe(true)
    const dir = store.workspaceDirOf(id)
    expect(dir).not.toBe(project)
    expect((await fs.stat(dir)).isDirectory()).toBe(true)
  })

  it('does not run when the user cancels, and the warning stays', async () => {
    const store = useSessions()
    const { id, project } = await missingProject(store)

    const ready = store.readyWorkspaceForTurn(id)
    await answerQuestion(null)

    expect(await ready).toBe(false)
    expect(store.missingWorkspaces[id]?.hostPath).toBe(project)
  })

  it('is not asked about while the Workspace is there', async () => {
    const store = useSessions()
    await store.init()

    expect(await store.readyWorkspaceForTurn(store.openSessionId!)).toBe(true)
    expect(useDialogStore().missingWorkspaceQuestion).toBeNull()
  })
})

describe('Overview inclusion', () => {
  it('starts the first Overview Summary through main when the toggle is enabled', async () => {
    const created = await sessionModule.createSession()
    await appendHistoryEntry(created.id, {
      preset: 'Assistant',
      kind: 'chat',
      prompt: 'set up the project',
      status: 'completed',
      artifacts: [],
    })
    const store = useSessions()
    await store.open(created.id)

    const kept = await store.setIncludedInOverviews(created.id, true, { language: 'de' })

    expect(kept).toBe(true)
    expect(store.sessions[created.id].includedInOverviews).toBe(true)
    expect(store.sessions[created.id].overviewSummaryState).toBe('pending')
  })
})
