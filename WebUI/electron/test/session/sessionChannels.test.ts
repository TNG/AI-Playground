import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A Session's reach from Channels (Reachable Session), seen through the Session module.

const dirs = vi.hoisted(() => ({ real: '', demo: '', messageMap: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
  getChannelMessageMapFile: () => dirs.messageMap,
  getChannelMessageMapDemoFile: () => dirs.messageMap.replace(/\.json$/, '-demo.json'),
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({
  emitSessionChanged: vi.fn(),
  emitSessionGroupsChanged: vi.fn(),
}))

const { createSession, deleteSession, listSessions, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const {
  forgetChannelMessagesOnDelete,
  isSessionReachable,
  resetSessionChannelsForTest,
  setRealShellFolders,
  setSessionReachable,
} = await import('../../session/sessionChannels')
const { readSessionSettings, writePresetSettings } = await import('../../session/sessionSettings')
const messageMap = await import('../../persist/channelMessageMap')
const { emitSessionChanged } = await import('../../kernel/kernelBus')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-channels-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.messageMap = path.join(root, 'channel-messages.json')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
  messageMap.setChannelMessageMapDeps({
    isDemoMode: () => false,
    harnessSessionOwners: async () => new Map(),
  })
  vi.mocked(emitSessionChanged).mockClear()
})

afterEach(async () => {
  resetSessionsForTest()
  resetSessionChannelsForTest()
  messageMap.resetChannelMessageMapForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.messageMap, { force: true })
})

const filesDir = (id: string) => path.join(dirs.real, id, 'files')

async function assistantCapabilities(id: string): Promise<unknown> {
  const settings = await readSessionSettings(id)
  return settings.Assistant?.bags.Assistant?.values.capabilities
}

describe('Reachable Session', () => {
  it('starts unreachable, and is remembered reachable across a re-list', async () => {
    const session = await createSession()
    expect(session.reachable).toBe(false)

    const changed = await setSessionReachable(session.id, true)

    expect(changed.reachable).toBe(true)
    expect((await listSessions())[0].reachable).toBe(true)
    expect(await isSessionReachable(session.id)).toBe(true)
    expect(emitSessionChanged).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: session.id, reachable: true }),
    )
  })

  it("turns on notify in the Session's Assistant settings, keeping what they held", async () => {
    const session = await createSession()
    await writePresetSettings(session.id, 'Assistant', {
      bags: {
        Assistant: { values: { capabilities: ['media'], thinking: true }, fromDefaults: false },
      },
    })

    await setSessionReachable(session.id, true)

    const settings = await readSessionSettings(session.id)
    expect(settings.Assistant.bags.Assistant).toEqual({
      values: { capabilities: ['media', 'notify'], thinking: true },
      fromDefaults: false,
    })
  })

  it('gives a Session Assistant never ran in the default capabilities plus notify', async () => {
    const session = await createSession()

    await setSessionReachable(session.id, true, { defaultCapabilities: ['web', 'notify', 'rag'] })

    expect(await assistantCapabilities(session.id)).toEqual(['web', 'notify', 'rag'])
    const other = await createSession()
    await setSessionReachable(other.id, true, { defaultCapabilities: ['web'] })
    expect(await assistantCapabilities(other.id)).toEqual(['web', 'notify'])
  })

  it('leaves the Assistant settings alone when turned off', async () => {
    const session = await createSession()
    await setSessionReachable(session.id, true, { defaultCapabilities: [] })

    await setSessionReachable(session.id, false)

    expect(await isSessionReachable(session.id)).toBe(false)
    expect(await assistantCapabilities(session.id)).toEqual(['notify'])
  })
})

describe('deleting a Session', () => {
  it("tombstones its Channel messages, leaving other Sessions' messages routed", async () => {
    forgetChannelMessagesOnDelete()
    const gone = await createSession()
    const kept = await createSession()
    await messageMap.recordChannelMessage('telegram', '1', {
      sessionRef: gone.id,
      harnessSessionId: 'aipg-agent-a',
    })
    await messageMap.recordChannelMessage('slack', '2', {
      sessionRef: gone.id,
      harnessSessionId: 'aipg-agent-run',
    })
    await messageMap.recordChannelMessage('telegram', '3', {
      sessionRef: kept.id,
      harnessSessionId: 'aipg-agent-b',
    })

    await deleteSession(gone.id)

    expect(await messageMap.channelMessageOwner('telegram', '1')).toEqual({ deletedSession: true })
    expect(await messageMap.channelMessageOwner('slack', '2')).toEqual({ deletedSession: true })
    expect(await messageMap.channelMessageOwner('telegram', '3')).toEqual({
      sessionRef: kept.id,
      harnessSessionId: 'aipg-agent-b',
    })
  })
})

describe('the real system shell', () => {
  it('keeps a Session using it from being made reachable', async () => {
    const session = await createSession()
    const other = await createSession()
    await setRealShellFolders([filesDir(session.id)])

    await expect(
      setSessionReachable(session.id, true, { defaultCapabilities: [] }),
    ).rejects.toThrow(/real system shell/)

    expect(await isSessionReachable(session.id)).toBe(false)
    expect(await assistantCapabilities(session.id)).toBeUndefined()
    await setSessionReachable(other.id, true)
    expect(await isSessionReachable(other.id)).toBe(true)
  })

  it('turned on in a Reachable Session turns reachable off, and tells the window', async () => {
    const session = await createSession()
    const bystander = await createSession()
    await setSessionReachable(session.id, true)
    await setSessionReachable(bystander.id, true)
    vi.mocked(emitSessionChanged).mockClear()

    await setRealShellFolders([filesDir(session.id)])

    expect(await isSessionReachable(session.id)).toBe(false)
    expect(await isSessionReachable(bystander.id)).toBe(true)
    expect(emitSessionChanged).toHaveBeenCalledWith(
      expect.objectContaining({ id: session.id, reachable: false }),
    )
  })

  it('turned off again lets the Session be made reachable', async () => {
    const session = await createSession()
    await setRealShellFolders([filesDir(session.id)])
    await setRealShellFolders([])

    await setSessionReachable(session.id, true)

    expect(await isSessionReachable(session.id)).toBe(true)
  })
})
