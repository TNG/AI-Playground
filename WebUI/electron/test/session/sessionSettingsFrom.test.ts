import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A new Session started with another Session's Session Settings, seen through Session creation.

const dirs = vi.hoisted(() => ({ real: '', demo: '' }))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getSessionsDemoDir: () => dirs.demo,
}))

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({
  emitSessionChanged: vi.fn(),
  emitSessionGroupsChanged: vi.fn(),
}))

const {
  createSession,
  createSessionGroup,
  listSessions,
  openSession,
  pinSession,
  renameSession,
  resetSessionsForTest,
  setSessionDeps,
} = await import('../../session/sessions')
const { presetSettingsFor, readSessionSettings, writePresetSettings } =
  await import('../../session/sessionSettings')
const { setSessionReachable } = await import('../../session/sessionChannels')
const { appendHistoryEntry } = await import('../../session/sessionHistory')
const { harnessSessionFor, sessionOfHarnessSession } = await import('../../session/sessionHarness')

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-session-settings-from-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
})

describe("New Session with another Session's settings", () => {
  it('carries every bag, sent with or still from defaults, and every variant', async () => {
    const source = await createSession()
    await writePresetSettings(source.id, 'Image Gen', {
      variant: 'Fast',
      bags: {
        'Image Gen:Fast': { values: { steps: 4 }, fromDefaults: false },
        'Image Gen:HD': { values: { steps: 30 }, fromDefaults: true },
      },
    })
    await presetSettingsFor(source.id, 'Video', 'Video', { frames: 24 })
    await writePresetSettings(source.id, 'Image Edit', { variant: 'Inpaint', bags: {} })

    const fresh = await createSession(undefined, { settingsFrom: source.id })

    expect(await readSessionSettings(fresh.id)).toEqual({
      'Image Gen': {
        variant: 'Fast',
        bags: {
          'Image Gen:Fast': { values: { steps: 4 }, fromDefaults: false },
          'Image Gen:HD': { values: { steps: 30 }, fromDefaults: true },
        },
      },
      Video: { bags: { Video: { values: { frames: 24 }, fromDefaults: true } } },
      'Image Edit': { variant: 'Inpaint', bags: {} },
    })
    expect(await presetSettingsFor(fresh.id, 'Video', 'Video', { frames: 48 })).toEqual({
      values: { frames: 24 },
      fromDefaults: true,
    })
  })

  it('carries a setting written just before the new Session is asked for', async () => {
    const source = await createSession()

    const written = writePresetSettings(source.id, 'Chat', {
      bags: { Chat: { values: { temperature: 0.3 }, fromDefaults: true } },
    })
    const fresh = await createSession(undefined, { settingsFrom: source.id })
    await written

    expect((await readSessionSettings(fresh.id)).Chat).toEqual({
      bags: { Chat: { values: { temperature: 0.3 }, fromDefaults: true } },
    })
  })

  it("carries Assistant's Mounted Folders and capabilities, and still lets it notify", async () => {
    const source = await createSession()
    const mountedFolders = [{ hostPath: '/work/notes', access: 'read-only' }]
    await writePresetSettings(source.id, 'Assistant', {
      bags: {
        Assistant: {
          values: { capabilities: ['media', 'web'], mountedFolders },
          fromDefaults: false,
        },
      },
    })

    const fresh = await createSession(undefined, {
      settingsFrom: source.id,
      defaultCapabilities: ['rag'],
    })

    expect((await readSessionSettings(fresh.id)).Assistant).toEqual({
      bags: {
        Assistant: {
          values: { capabilities: ['media', 'web', 'notify'], mountedFolders },
          fromDefaults: false,
        },
      },
    })
  })

  it('takes nothing else of the source, and puts the new Session in the group asked for', async () => {
    const source = await createSession()
    await renameSession(source.id, 'Tuned work')
    await pinSession(source.id, true)
    await setSessionReachable(source.id, false)
    await appendHistoryEntry(source.id, {
      preset: 'Dummy Image (test)',
      kind: 'image',
      prompt: 'a red fox',
      status: 'completed',
      artifacts: [],
    })
    const sourceHarness = await harnessSessionFor(source.id, 'Assistant')
    const { group } = await createSessionGroup(source.id, 'Related')

    const fresh = await createSession(group.id, { settingsFrom: source.id })

    expect(fresh).toMatchObject({
      title: '',
      renamed: false,
      pinned: false,
      reachable: true,
      groupId: group.id,
      presetsUsed: [],
    })
    expect((await openSession(fresh.id)).timeline).toEqual([])
    const freshHarness = await harnessSessionFor(fresh.id, 'Assistant')
    expect(freshHarness.harnessSessionId).not.toBe(sourceHarness.harnessSessionId)
    expect(await sessionOfHarnessSession(sourceHarness.harnessSessionId)).toBe(source.id)
  })

  it('leaves the two Sessions independent afterwards', async () => {
    const source = await createSession()
    await writePresetSettings(source.id, 'Chat', {
      bags: { Chat: { values: { temperature: 0.2, tools: ['web'] }, fromDefaults: false } },
    })
    const fresh = await createSession(undefined, { settingsFrom: source.id })

    await writePresetSettings(fresh.id, 'Chat', {
      bags: { Chat: { values: { temperature: 0.9, tools: [] }, fromDefaults: false } },
    })
    await writePresetSettings(source.id, 'Image Gen', { variant: 'Fast', bags: {} })

    expect(await readSessionSettings(source.id)).toEqual({
      Chat: {
        bags: { Chat: { values: { temperature: 0.2, tools: ['web'] }, fromDefaults: false } },
      },
      'Image Gen': { variant: 'Fast', bags: {} },
    })
    expect(await readSessionSettings(fresh.id)).toEqual({
      Chat: { bags: { Chat: { values: { temperature: 0.9, tools: [] }, fromDefaults: false } } },
    })
  })

  it('fails without leaving a Session behind when the source is missing', async () => {
    await expect(createSession(undefined, { settingsFrom: 'session-gone' })).rejects.toThrow(
      'no such session: session-gone',
    )

    expect(await listSessions()).toEqual([])
  })

  it('fails without leaving a Session behind when the source cannot be read', async () => {
    const source = await createSession()
    await fs.writeFile(path.join(dirs.real, source.id, 'session.json'), '{ not json')

    await expect(createSession(undefined, { settingsFrom: source.id })).rejects.toThrow(
      `session unreadable: ${source.id}`,
    )

    expect((await listSessions()).map((session) => session.id)).toEqual([source.id])
  })
})
