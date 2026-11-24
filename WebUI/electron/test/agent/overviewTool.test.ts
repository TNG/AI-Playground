import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The `overview_data` tool is the Overview Agent's whole read side: one range in,
// the included Sessions' turns and picture candidates out. It is exercised the way
// the agent reaches it — through the capability's tool against real `session.json`
// files and real History Entries on disk, with Electron and Pi mocked away.

const dirs = vi.hoisted(() => ({ real: '', demo: '', games: '', mediaRecords: '' }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => dirs.real, getAppPath: () => dirs.real },
  BrowserWindow: class {},
  net: {},
}))

vi.mock('../../persist/userDataPaths.ts', () => ({
  getSessionsDir: () => dirs.real,
  getLegacySessionsDir: () => dirs.real,
  getAppWorkspacesDir: () => `${dirs.real}-workspaces`,
  getSessionsDemoDir: () => dirs.demo,
  getLegacySessionsDemoDir: () => dirs.demo,
  getAppWorkspacesDemoDir: () => `${dirs.demo}-workspaces`,
  getGamesDir: () => dirs.games,
  getMediaRecordsDir: () => dirs.mediaRecords,
  getMediaRecordsDemoDir: () => `${dirs.mediaRecords}-demo`,
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({
  emitSessionChanged: vi.fn(),
  emitSessionGroupsChanged: vi.fn(),
}))

vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

const { overviewCapability } = await import('../../agent/capabilities/overview.ts')
const {
  createSession,
  mutateSession,
  resetSessionsForTest,
  setSessionDeps,
  sessionPaths,
  setSessionIncludedInOverviews,
} = await import('../../session/sessions')
const { writeHistoryLines } = await import('../../persist/sessionFiles')
const { addSessionFolder } = await import('../../session/sessionFolders')
const { ensureWorkspaceEntry } = await import('../../session/appWorkspace')
const { createGame, updateGame } = await import('../../agent/games/gameLibrary')
const { sessionFolderMediaUrl } = await import('@/lib/comfyWorkflow')
import type { HistoryEntry } from '@/types/sessionIpc'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = new Date(2026, 10, 24, 15, 30).getTime()
const TODAY = new Date(2026, 10, 24).getTime()

type Host = Parameters<NonNullable<typeof overviewCapability.buildTools>>[0]

type Tool = {
  name: string
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

function hostFor(sessionRef?: string): Host {
  return {
    sessionId: 'harness-1',
    ...(sessionRef ? { sessionRef } : {}),
    workspaceDir: path.join(dirs.real, 'workspace'),
    agentDir: dirs.real,
    toolSpecs: [],
    keepModelsLoaded: false,
  } as unknown as Host
}

async function overviewTool(host: Host): Promise<Tool> {
  const tools = await overviewCapability.buildTools!(host)
  return tools[0] as unknown as Tool
}

function textOf(result: unknown): string {
  return ((result as { content: { text: string }[] }).content ?? [])
    .map((part) => part.text)
    .join('\n')
}

async function dataFrom(host: Host, range: unknown): Promise<Record<string, unknown>> {
  const result = await (await overviewTool(host)).execute('call-1', { range })
  return JSON.parse(textOf(result))
}

let sessionCounter = 0

function historyEntry(overrides: Partial<HistoryEntry>): HistoryEntry {
  sessionCounter += 1
  return {
    id: `entry-${sessionCounter}`,
    timestamp: NOW - HOUR,
    preset: 'Assistant',
    kind: 'chat',
    prompt: `prompt ${sessionCounter}`,
    status: 'completed',
    artifacts: [],
    ...overrides,
  }
}

async function seedSession(
  entries: HistoryEntry[],
  options: { included?: boolean; updatedAt?: number } = {},
): Promise<string> {
  const { id } = await createSession()
  await writeHistoryLines(
    id,
    entries.map((entry) => JSON.stringify(entry)),
  )
  const newest = entries.reduce(
    (max, entry) => Math.max(max, entry.timestamp),
    options.updatedAt ?? NOW,
  )
  await mutateSession(id, (file) => ({ ...file, updatedAt: newest }))
  await setSessionIncludedInOverviews(id, options.included ?? true)
  return id
}

async function writeFile(hostPath: string): Promise<void> {
  await fs.mkdir(path.dirname(hostPath), { recursive: true })
  await fs.writeFile(hostPath, 'bytes')
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-overview-tool-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.games = path.join(root, 'games')
  dirs.mediaRecords = path.join(root, 'media-records')
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  vi.useRealTimers()
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.games, { recursive: true, force: true })
})

describe('overview_data', () => {
  it('is the read tool of the overview capability', async () => {
    expect(overviewCapability.id).toBe('overview')
    const tools = await overviewCapability.buildTools!(hostFor())
    expect(tools.map((tool) => tool.name)).toEqual(['overview_data', 'overview_write'])
  })

  it('resolves every named range and echoes the concrete window', async () => {
    await seedSession([historyEntry({ timestamp: NOW - HOUR })], { updatedAt: NOW })
    const tool = await overviewTool(hostFor())

    const last24 = await dataFrom(hostFor(), 'last-24h')
    expect(last24.window).toEqual({ from: NOW - DAY, to: NOW })

    const today = await dataFrom(hostFor(), 'today')
    expect(today.window).toEqual({ from: TODAY, to: TODAY + DAY })

    const yesterday = await dataFrom(hostFor(), 'yesterday')
    expect(yesterday.window).toEqual({ from: TODAY - DAY, to: TODAY })

    const week = await dataFrom(hostFor(), 'last-7-days')
    expect(week.window).toEqual({ from: TODAY - 6 * DAY, to: NOW })

    const month = await dataFrom(hostFor(), 'last-30-days')
    expect(month.window).toEqual({ from: TODAY - 29 * DAY, to: NOW })

    // The window rides on an empty result too, so the answer can always state it.
    const quiet = await dataFrom(hostFor(), 'yesterday')
    expect(quiet.outcome).toBe('none-in-range')
    expect(quiet.window).toEqual({ from: TODAY - DAY, to: TODAY })
    expect(tool.name).toBe('overview_data')
  })

  it('is from-inclusive and to-exclusive', async () => {
    const from = new Date(2026, 10, 24, 10).getTime()
    const to = new Date(2026, 10, 24, 12).getTime()
    const { id } = await createSession()
    await writeHistoryLines(id, [
      JSON.stringify(historyEntry({ prompt: 'just before', timestamp: from - 1 })),
      JSON.stringify(historyEntry({ prompt: 'first', timestamp: from })),
      JSON.stringify(historyEntry({ prompt: 'last', timestamp: to - 1 })),
      JSON.stringify(historyEntry({ prompt: 'at the end', timestamp: to })),
    ])
    await mutateSession(id, (file) => ({ ...file, updatedAt: to }))
    await setSessionIncludedInOverviews(id, true)

    const data = await dataFrom(hostFor(), {
      from: '2026-11-24T10:00:00',
      to: '2026-11-24T12:00:00',
    })

    const sessions = data.sessions as { entries: { prompt: string }[] }[]
    expect(sessions[0].entries.map((entry) => entry.prompt)).toEqual(['last', 'first'])
  })

  it('reads only included Sessions and never the reporting Session', async () => {
    const included = await seedSession([historyEntry({})])
    const excluded = await seedSession([historyEntry({})], { included: false })
    const reporting = await seedSession([historyEntry({})])

    const data = await dataFrom(hostFor(reporting), 'last-24h')

    const ids = (data.sessions as { id: string }[]).map((session) => session.id)
    expect(ids).toEqual([included])
    expect(ids).not.toContain(excluded)
    expect(ids).not.toContain(reporting)
    expect(data.includedSessions).toBe(1)
  })

  it("keeps an Agent Run's steps inside their Session", async () => {
    const step = {
      preset: 'Game Agent',
      kind: 'agent' as const,
      taskName: 'Digest',
      harnessSessionId: 'aipg-agent-run',
      response: 'Tuned the collision boxes.',
    }
    const { id } = await createSession()
    await writeHistoryLines(id, [
      JSON.stringify(historyEntry({ ...step, prompt: 'step one', timestamp: NOW - 2 * HOUR })),
      JSON.stringify(historyEntry({ ...step, prompt: 'step two', timestamp: NOW - HOUR })),
    ])
    await mutateSession(id, (file) => ({ ...file, updatedAt: NOW }))
    await setSessionIncludedInOverviews(id, true)

    const data = await dataFrom(hostFor(), 'last-24h')
    const sessions = data.sessions as {
      id: string
      entries: { prompt: string; agent?: string }[]
    }[]

    expect(sessions).toHaveLength(1)
    expect(sessions[0].id).toBe(id)
    expect(sessions[0].entries.map((entry) => entry.prompt)).toEqual(['step two', 'step one'])
    expect(sessions[0].entries.every((entry) => entry.agent === 'Digest')).toBe(true)
  })

  it('caps a Session at 40 turns and 8 pictures, with the counters', async () => {
    const { id } = await createSession()
    const filesDir = sessionPaths(id).filesDir
    const entries: HistoryEntry[] = []
    for (let index = 0; index < 45; index++) {
      const image = index >= 35
      const name = `picture-${index}.png`
      if (image) await writeFile(path.join(filesDir, name))
      entries.push(
        historyEntry({
          prompt: `turn ${index}`,
          timestamp: NOW - (45 - index) * 60_000,
          ...(image
            ? {
                kind: 'image' as const,
                preset: 'Image Gen',
                artifacts: [{ path: `files/${name}`, mediaType: 'image' as const }],
              }
            : {}),
        }),
      )
    }
    await writeHistoryLines(
      id,
      entries.map((entry) => JSON.stringify(entry)),
    )
    await mutateSession(id, (file) => ({ ...file, updatedAt: NOW }))
    await setSessionIncludedInOverviews(id, true)

    const data = await dataFrom(hostFor(), 'last-24h')
    const [session] = data.sessions as {
      entries: { prompt: string }[]
      totalEntries: number
      truncated: boolean
      covers: unknown[]
      totalCovers: number
      coversTruncated: boolean
    }[]

    expect(session.entries).toHaveLength(40)
    expect(session.entries[0].prompt).toBe('turn 44')
    expect(session.totalEntries).toBe(45)
    expect(session.truncated).toBe(true)
    expect(data.truncated).toBe(true)
    expect(session.covers).toHaveLength(8)
    expect(session.totalCovers).toBe(10)
    expect(session.coversTruncated).toBe(true)
  })

  it('keeps 400 turn lines across the whole report', async () => {
    for (let index = 0; index < 11; index++) {
      const entries = Array.from({ length: 40 }, (_, line) =>
        historyEntry({
          prompt: `session ${index} turn ${line}`,
          timestamp: NOW - (index + 1) * HOUR - line * 60_000,
        }),
      )
      await seedSession(entries, { updatedAt: NOW - index * HOUR })
    }

    const data = await dataFrom(hostFor(), 'last-24h')
    const sessions = data.sessions as { entries: unknown[]; truncated: boolean }[]

    expect(sessions.reduce((sum, session) => sum + session.entries.length, 0)).toBe(400)
    expect(data.truncated).toBe(true)
    expect(sessions.at(-1)?.entries).toEqual([])
    expect(sessions.at(-1)?.truncated).toBe(true)
  })

  it("offers an image Artifact, a video's timeline thumbnail and a game's icon", async () => {
    const { id: image } = await createSession()
    const picked = path.join(dirs.real, '..', 'photos')
    const { list } = await addSessionFolder(image, picked)
    const folder = list.folders.find((entry) => entry.hostPath === picked)!
    await writeFile(path.join(picked, 'cat.png'))
    await writeHistoryLines(
      image,
      [
        historyEntry({
          kind: 'image',
          preset: 'Image Gen',
          prompt: 'a cat in a hat',
          artifacts: [{ folderId: folder.id, path: 'cat.png', mediaType: 'image' }],
        }),
      ].map((entry) => JSON.stringify(entry)),
    )
    await mutateSession(image, (file) => ({ ...file, updatedAt: NOW }))
    await setSessionIncludedInOverviews(image, true)

    const { id: video } = await createSession()
    const workspace = await ensureWorkspaceEntry(video)
    await writeFile(path.join(workspace.hostPath, 'clip.mp4'))
    await writeFile(path.join(workspace.hostPath, 'clip-thumb.png'))
    await writeHistoryLines(
      video,
      [
        historyEntry({
          kind: 'video',
          preset: 'Video',
          prompt: 'a wave breaking',
          artifacts: [{ folderId: workspace.id, path: 'clip.mp4', mediaType: 'video' }],
        }),
      ].map((entry) => JSON.stringify(entry)),
    )
    await mutateSession(video, (file) => ({
      ...file,
      updatedAt: NOW,
      timeline: [
        {
          id: 'msg-1',
          role: 'assistant',
          createdAt: NOW - HOUR,
          parts: [
            {
              type: 'data-media',
              data: {
                runId: 'run-1',
                mode: 'video',
                preset: 'Video',
                status: 'completed',
                items: [
                  {
                    id: 'item-1',
                    state: 'done',
                    mode: 'video',
                    settings: {},
                    type: 'video',
                    videoUrl: sessionFolderMediaUrl(video, workspace.id, 'clip.mp4'),
                    thumbnailUrl: sessionFolderMediaUrl(video, workspace.id, 'clip-thumb.png'),
                  },
                ],
              },
            },
          ],
        },
      ],
    }))
    await setSessionIncludedInOverviews(video, true)

    const { id: game } = await createSession()
    const created = createGame({ name: 'Space Dodger' }, dirs.games)
    await writeFile(path.join(created.dir, 'icon.png'))
    updateGame(created.dir, { icon: 'icon.png' })
    await writeHistoryLines(
      game,
      [historyEntry({ kind: 'agent', preset: 'Game Agent', prompt: 'make it harder' })].map(
        (entry) => JSON.stringify(entry),
      ),
    )
    await mutateSession(game, (file) => ({
      ...file,
      updatedAt: NOW,
      harnessWorkspaces: { 'Game Agent': created.dir },
    }))
    await setSessionIncludedInOverviews(game, true)

    const audio = await seedSession([
      historyEntry({
        kind: 'tts',
        preset: 'Text to Speech',
        artifacts: [{ path: 'files/speech.wav', mediaType: 'audio' }],
      }),
    ])

    const data = await dataFrom(hostFor(), 'last-24h')
    const byId = new Map(
      (data.sessions as { id: string; covers: { path: string; source: string }[] }[]).map(
        (session) => [session.id, session.covers],
      ),
    )

    expect(byId.get(image)).toEqual([
      expect.objectContaining({ path: path.join(picked, 'cat.png'), source: 'artifact' }),
    ])
    expect(byId.get(video)).toEqual([
      expect.objectContaining({
        path: path.join(workspace.hostPath, 'clip-thumb.png'),
        source: 'video-thumbnail',
      }),
    ])
    expect(byId.get(game)).toEqual([
      expect.objectContaining({ path: path.join(created.dir, 'icon.png'), source: 'game-icon' }),
    ])
    expect(byId.get(audio)).toEqual([])
  })

  it('distinguishes "nothing is included" from "the included Sessions were quiet"', async () => {
    await seedSession([historyEntry({})], { included: false })

    const noneIncluded = await dataFrom(hostFor(), 'last-24h')
    expect(noneIncluded.outcome).toBe('none-included')
    expect(noneIncluded.includedSessions).toBe(0)
    expect(noneIncluded.message).toMatch(/included in Overviews/i)

    resetSessionsForTest()
    await fs.rm(dirs.real, { recursive: true, force: true })
    setSessionDeps({ isDemoMode: () => false })
    await seedSession([historyEntry({ timestamp: NOW - 10 * DAY })])

    const quiet = await dataFrom(hostFor(), 'last-24h')
    expect(quiet.outcome).toBe('none-in-range')
    expect(quiet.includedSessions).toBe(1)
    expect(quiet.message).toMatch(/no turn/i)
  })

  it('answers a nonsense range as text, not a thrown error', async () => {
    const result = await (
      await overviewTool(hostFor())
    ).execute('call-1', {
      range: 'since forever',
    })
    expect(textOf(result)).toMatch(/range|date/i)
  })
})
