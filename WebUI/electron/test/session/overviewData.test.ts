import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const dirs = vi.hoisted(() => ({ real: '', demo: '', games: '', mediaRecords: '' }))

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

vi.mock('../../observability/logger', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../kernel/kernelBus', () => ({
  emitSessionChanged: vi.fn(),
  emitSessionGroupsChanged: vi.fn(),
}))

const { resolveOverviewWindow } = await import('../../session/overviewRange')
const { collectOverviewData } = await import('../../session/overviewData')
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
const { NOW, HOUR, DAY, TODAY, historyEntry, seedSession, writeFile } =
  await import('../overviewFixtures')

const YESTERDAY = new Date(2026, 10, 23).getTime()

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-overviews-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.games = path.join(root, 'games')
  dirs.mediaRecords = path.join(root, 'media-records')
})

beforeEach(() => {
  setSessionDeps({ isDemoMode: () => false })
})

afterEach(async () => {
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.games, { recursive: true, force: true })
})

describe('range resolution', () => {
  it('rolls last-24h back from now', () => {
    expect(resolveOverviewWindow('last-24h', NOW)).toEqual({ from: NOW - DAY, to: NOW })
  })

  it('rolls a named number of hours back from now', () => {
    expect(resolveOverviewWindow({ lastHours: 12 }, NOW)).toEqual({ from: NOW - 12 * HOUR, to: NOW })
    expect(resolveOverviewWindow({ lastHours: 24 }, NOW)).toEqual(
      resolveOverviewWindow('last-24h', NOW),
    )
  })

  it('refuses an hour count that is not a whole number of hours it supports', () => {
    for (const lastHours of [0, -1, 1.5, 8761]) {
      expect(() => resolveOverviewWindow({ lastHours }, NOW)).toThrow(/hour/i)
    }
  })

  it('aligns today and yesterday to local calendar days', () => {
    expect(resolveOverviewWindow('today', NOW)).toEqual({ from: TODAY, to: TODAY + DAY })
    expect(resolveOverviewWindow('yesterday', NOW)).toEqual({ from: YESTERDAY, to: TODAY })
  })

  it('aligns the day ranges to local midnight and ends them now', () => {
    expect(resolveOverviewWindow('last-7-days', NOW)).toEqual({ from: TODAY - 6 * DAY, to: NOW })
    expect(resolveOverviewWindow('last-30-days', NOW)).toEqual({ from: TODAY - 29 * DAY, to: NOW })
  })

  it('reads an explicit range as local dates, from-inclusive and to-exclusive', () => {
    expect(resolveOverviewWindow({ from: '2026-11-20', to: '2026-11-22' }, NOW)).toEqual({
      from: new Date(2026, 10, 20).getTime(),
      to: new Date(2026, 10, 22).getTime(),
    })
    expect(
      resolveOverviewWindow({ from: '2026-11-20T08:00:00Z', to: '2026-11-20T09:30:00Z' }, NOW),
    ).toEqual({
      from: Date.parse('2026-11-20T08:00:00Z'),
      to: Date.parse('2026-11-20T09:30:00Z'),
    })
  })

  it('refuses a range that is not a range', () => {
    expect(() => resolveOverviewWindow({ from: 'not a date', to: '2026-11-22' }, NOW)).toThrow(
      /date/i,
    )
    expect(() => resolveOverviewWindow({ from: '2026-11-22', to: '2026-11-20' }, NOW)).toThrow(
      /before/i,
    )
  })
})

function query(overrides: Partial<Parameters<typeof collectOverviewData>[0]> = {}) {
  return collectOverviewData({ range: 'last-24h', now: NOW, ...overrides })
}

describe('which Sessions appear', () => {
  it('reads only Sessions the user included', async () => {
    const included = await seedSession([historyEntry({})])
    const excluded = await seedSession([historyEntry({})], { included: false })

    const data = await query()

    expect(data.outcome).toBe('ok')
    expect(data.includedSessions).toBe(1)
    expect(data.sessions.map((session) => session.id)).toEqual([included])
    expect(data.sessions.map((session) => session.id)).not.toContain(excluded)
  })

  it('never reports the Session that asked', async () => {
    const reporting = await seedSession([historyEntry({})])
    const other = await seedSession([historyEntry({})])

    const data = await query({ excludingSessionId: reporting })

    expect(data.includedSessions).toBe(1)
    expect(data.sessions.map((session) => session.id)).toEqual([other])
    expect(data.sessions.map((session) => session.id)).not.toContain(reporting)
  })

  it('counts a quiet included Session but does not list it', async () => {
    const busy = await seedSession([historyEntry({})])
    await seedSession([historyEntry({ timestamp: NOW - 10 * DAY })], { updatedAt: NOW })
    await seedSession([], { updatedAt: NOW })

    const data = await query()

    expect(data.includedSessions).toBe(3)
    expect(data.sessions.map((session) => session.id)).toEqual([busy])
  })

  it('keeps an Agent Run inside the Session it ran in', async () => {
    const run = {
      preset: 'Assistant',
      kind: 'agent' as const,
      response: 'Built the asteroid field.',
      taskName: 'Digest',
      harnessSessionId: 'aipg-agent-run',
      timestamp: NOW - 2 * HOUR,
    }
    const { id } = await createSession()
    await writeHistoryLines(id, [
      JSON.stringify(historyEntry({ prompt: 'a step', ...run })),
      JSON.stringify(historyEntry({ prompt: 'another step', ...run, timestamp: NOW - HOUR })),
    ])
    await mutateSession(id, (file) => ({ ...file, updatedAt: NOW }))
    await setSessionIncludedInOverviews(id, true)

    const data = await query()

    expect(data.sessions).toHaveLength(1)
    expect(data.sessions[0].entries.map((entry) => entry.prompt)).toEqual([
      'another step',
      'a step',
    ])
    expect(data.sessions[0].entries.map((entry) => entry.agent)).toEqual(['Digest', 'Digest'])
  })
})

describe('the range', () => {
  it('is from-inclusive and to-exclusive, and keeps the newest turn first', async () => {
    const from = new Date(2026, 10, 24, 10).getTime()
    const to = new Date(2026, 10, 24, 12).getTime()
    const { id } = await createSession()
    await writeHistoryLines(id, [
      JSON.stringify(historyEntry({ prompt: 'just before', timestamp: from - 1 })),
      JSON.stringify(historyEntry({ prompt: 'first in range', timestamp: from })),
      JSON.stringify(historyEntry({ prompt: 'last in range', timestamp: to - 1 })),
      JSON.stringify(historyEntry({ prompt: 'at the end', timestamp: to })),
    ])
    await mutateSession(id, (file) => ({ ...file, updatedAt: to }))
    await setSessionIncludedInOverviews(id, true)

    const data = await query({ range: { from: '2026-11-24T10:00:00', to: '2026-11-24T12:00:00' } })

    expect(data.window).toEqual({ from, to })
    expect(data.sessions[0].entries.map((entry) => entry.prompt)).toEqual([
      'last in range',
      'first in range',
    ])
  })

  it('flags a span wider than 30 days instead of refusing it', async () => {
    await seedSession([historyEntry({ timestamp: NOW - 10 * DAY })])
    const wide = await query({ range: { from: '2026-10-01', to: '2026-11-24' } })
    expect(wide.outcome).toBe('ok')
    expect(wide.wideRange).toBe(true)

    const narrow = await query({ range: { from: '2026-11-20', to: '2026-11-24' } })
    expect(narrow.wideRange).toBe(false)
  })
})

describe('the empty cases', () => {
  it('says nothing is included at all', async () => {
    await seedSession([historyEntry({})], { included: false })

    const data = await query()

    expect(data.outcome).toBe('none-included')
    expect(data.includedSessions).toBe(0)
    expect(data.sessions).toEqual([])
    expect(data.message).toMatch(/included in Overviews/i)
    expect(data.window).toBeDefined()
  })

  it('tells quiet included Sessions from none at all', async () => {
    await seedSession([historyEntry({ timestamp: NOW - 10 * DAY })])

    const data = await query()

    expect(data.outcome).toBe('none-in-range')
    expect(data.includedSessions).toBe(1)
    expect(data.sessions).toEqual([])
    expect(data.message).toMatch(/no turn/i)
  })
})

describe('caps and counters', () => {
  it('keeps the newest 40 turns of a Session and counts the rest', async () => {
    const entries = Array.from({ length: 45 }, (_, index) =>
      historyEntry({
        prompt: `turn ${index}`,
        timestamp: NOW - (45 - index) * 60_000,
      }),
    )
    await seedSession(entries)

    const data = await query()
    const [session] = data.sessions

    expect(session.entries).toHaveLength(40)
    expect(session.entries[0].prompt).toBe('turn 44')
    expect(session.entries.at(-1)?.prompt).toBe('turn 5')
    expect(session.totalEntries).toBe(45)
    expect(session.truncated).toBe(true)
    expect(data.truncated).toBe(true)
  })

  it('keeps 400 turn lines and omits whole Sessions from the Overview', async () => {
    for (let index = 0; index < 11; index++) {
      const entries = Array.from({ length: 40 }, (_, line) =>
        historyEntry({
          prompt: `session ${index} turn ${line}`,
          timestamp: NOW - (index + 1) * HOUR - line * 60_000,
        }),
      )
      await seedSession(entries, { updatedAt: NOW - index * HOUR })
    }

    const data = await query()

    const shown = data.sessions.reduce((sum, session) => sum + session.entries.length, 0)
    expect(shown).toBe(400)
    expect(data.sessions).toHaveLength(10)
    expect(data.sessions.every((session) => session.entries.length > 0)).toBe(true)
    expect(data.sessionsOmitted).toBe(1)
    expect(data.totalEntries).toBe(440)
    expect(data.truncated).toBe(true)
  })

  it('offers at most 8 pictures per Session, newest first', async () => {
    const { id } = await createSession()
    const filesDir = sessionPaths(id).filesDir
    const entries = await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        const name = `picture-${index}.png`
        await writeFile(path.join(filesDir, name))
        return historyEntry({
          kind: 'image',
          preset: 'Image Gen',
          prompt: `picture ${index}`,
          timestamp: NOW - (10 - index) * 60_000,
          artifacts: [{ path: `files/${name}`, mediaType: 'image' }],
        })
      }),
    )
    await writeHistoryLines(
      id,
      entries.map((entry) => JSON.stringify(entry)),
    )
    await mutateSession(id, (file) => ({ ...file, updatedAt: NOW }))
    await setSessionIncludedInOverviews(id, true)

    const [session] = (await query()).sessions

    expect(session.covers).toHaveLength(8)
    expect(session.totalCovers).toBe(10)
    expect(session.coversTruncated).toBe(true)
    expect(session.covers[0].prompt).toBe('picture 9')
    expect(session.covers.at(-1)?.prompt).toBe('picture 2')
  })
})

describe('picture candidates', () => {
  it("offers an image Artifact's file, resolved through its folder", async () => {
    const { id } = await createSession()
    const picked = path.join(dirs.real, '..', 'picked-photos')
    const { list } = await addSessionFolder(id, picked)
    const folder = list.folders.find((entry) => entry.hostPath === picked)!
    await writeFile(path.join(picked, 'cat.png'))
    await writeHistoryLines(
      id,
      [
        historyEntry({
          kind: 'image',
          preset: 'Image Gen',
          prompt: 'a cat in a hat',
          artifacts: [{ folderId: folder.id, path: 'cat.png', mediaType: 'image' }],
        }),
      ].map((entry) => JSON.stringify(entry)),
    )
    await mutateSession(id, (file) => ({ ...file, updatedAt: NOW }))
    await setSessionIncludedInOverviews(id, true)

    const [session] = (await query()).sessions

    expect(session.covers).toEqual([
      {
        path: path.join(picked, 'cat.png'),
        mediaType: 'image',
        prompt: 'a cat in a hat',
        time: NOW - HOUR,
        source: 'artifact',
      },
    ])
  })

  it("offers a video's adopted timeline thumbnail", async () => {
    const { id } = await createSession()
    const workspace = await ensureWorkspaceEntry(id)
    await writeFile(path.join(workspace.hostPath, 'clip.mp4'))
    await writeFile(path.join(workspace.hostPath, 'clip-thumb.png'))
    const videoUrl = sessionFolderMediaUrl(id, workspace.id, 'clip.mp4')
    const thumbnailUrl = sessionFolderMediaUrl(id, workspace.id, 'clip-thumb.png')
    await writeHistoryLines(
      id,
      [
        historyEntry({
          kind: 'video',
          preset: 'Video',
          prompt: 'a wave breaking',
          artifacts: [{ folderId: workspace.id, path: 'clip.mp4', mediaType: 'video' }],
        }),
      ].map((entry) => JSON.stringify(entry)),
    )
    await mutateSession(id, (file) => ({
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
                    videoUrl,
                    thumbnailUrl,
                  },
                ],
              },
            },
          ],
        },
      ],
    }))
    await setSessionIncludedInOverviews(id, true)

    const [session] = (await query()).sessions

    expect(session.covers).toHaveLength(1)
    expect(session.covers[0]).toMatchObject({
      path: path.join(workspace.hostPath, 'clip-thumb.png'),
      mediaType: 'image',
      prompt: 'a wave breaking',
      source: 'video-thumbnail',
    })
  })

  it("offers a game's icon from its library card", async () => {
    const { id } = await createSession()
    const game = createGame({ name: 'Space Dodger' }, dirs.games)
    await writeFile(path.join(game.dir, 'icon.png'))
    updateGame(game.dir, { icon: 'icon.png' })
    await writeHistoryLines(
      id,
      [
        historyEntry({
          kind: 'agent',
          preset: 'Game Agent',
          prompt: 'make it harder',
          artifacts: [],
        }),
      ].map((entry) => JSON.stringify(entry)),
    )
    await mutateSession(id, (file) => ({
      ...file,
      updatedAt: NOW,
      harnessWorkspaces: { 'Game Agent': game.dir },
    }))
    await setSessionIncludedInOverviews(id, true)

    const [session] = (await query()).sessions

    expect(session.covers).toEqual([
      {
        path: path.join(game.dir, 'icon.png'),
        mediaType: 'image',
        prompt: 'Space Dodger',
        time: expect.any(Number),
        source: 'game-icon',
      },
    ])
  })

  it('offers nothing for audio or a 3D-only Session', async () => {
    const audio = await seedSession([
      historyEntry({
        kind: 'tts',
        preset: 'Text to Speech',
        artifacts: [{ path: 'files/speech.wav', mediaType: 'audio' }],
      }),
    ])
    const threeD = await seedSession([
      historyEntry({
        kind: 'edit',
        preset: 'Image To 3D Model',
        artifacts: [{ path: 'files/model.glb', mediaType: 'model3d' }],
      }),
    ])

    const data = await query()

    expect(data.sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining([audio, threeD]),
    )
    for (const session of data.sessions) {
      expect(session.covers).toEqual([])
      expect(session.totalCovers).toBe(0)
      expect(session.coversTruncated).toBe(false)
    }
  })
})
