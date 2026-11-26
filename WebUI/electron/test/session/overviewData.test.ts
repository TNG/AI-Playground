import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The Overview's read side: the app chooses every included Session whose newest
// History Entry is in the window, leaves out the Session that asked, and hands the
// page each Session's Title and stored Overview Summary. No model chooses a set.

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
const { selectOverviewSessions } = await import('../../session/overviewData')
const { createSession, mutateSession, resetSessionsForTest, setSessionDeps, sessionPaths } =
  await import('../../session/sessions')
const { NOW, HOUR, DAY, TODAY, historyEntry, seedSession } = await import('../overviewFixtures')

const YESTERDAY = new Date(2026, 10, 23).getTime()

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-overviews-'))
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

describe('range resolution', () => {
  it('rolls last-24h back from now', () => {
    expect(resolveOverviewWindow('last-24h', NOW)).toEqual({ from: NOW - DAY, to: NOW })
  })

  it('rolls a named number of hours back from now', () => {
    expect(resolveOverviewWindow({ lastHours: 12 }, NOW)).toEqual({
      from: NOW - 12 * HOUR,
      to: NOW,
    })
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

function query(overrides: Partial<Parameters<typeof selectOverviewSessions>[0]> = {}) {
  return selectOverviewSessions({ range: 'last-24h', now: NOW, ...overrides })
}

describe('which Sessions appear', () => {
  it('reads only Sessions the user included, and only readable ones', async () => {
    const included = await seedSession([historyEntry({})], { summary: 'Included work.' })
    const excluded = await seedSession([historyEntry({})], { included: false })
    const broken = await seedSession([historyEntry({})])
    await fs.writeFile(sessionPaths(broken).sessionFile, '{ not json', 'utf8')

    const selection = await query()

    expect(selection.outcome).toBe('ok')
    expect(selection.includedSessions).toBe(1)
    expect(selection.sessions.map((session) => session.id)).toEqual([included])
    expect(selection.sessions.map((session) => session.id)).not.toContain(excluded)
    expect(selection.sessions.map((session) => session.id)).not.toContain(broken)
  })

  it('never reports the Session that asked', async () => {
    const reporting = await seedSession([historyEntry({})], { summary: 'Asking.' })
    const other = await seedSession([historyEntry({})], { summary: 'Other work.' })

    const selection = await query({ excludingSessionId: reporting })

    expect(selection.includedSessions).toBe(1)
    expect(selection.sessions.map((session) => session.id)).toEqual([other])
    expect(selection.sessions.map((session) => session.id)).not.toContain(reporting)
  })

  it('has no included Sessions when only the asking Session is included', async () => {
    const reporting = await seedSession([historyEntry({})])

    const selection = await query({ excludingSessionId: reporting })

    expect(selection.outcome).toBe('none-included')
    expect(selection.includedSessions).toBe(0)
  })

  it('selects by the newest History Entry, not by any entry in the window', async () => {
    const from = new Date(2026, 10, 23, 10).getTime()
    const to = new Date(2026, 10, 24, 10).getTime()
    const quietSince = await seedSession(
      [
        historyEntry({ prompt: 'was in the window', timestamp: from + HOUR }),
        historyEntry({ prompt: 'newest is after it', timestamp: to + HOUR }),
      ],
      { summary: 'Quiet since.' },
    )
    const active = await seedSession(
      [
        historyEntry({ prompt: 'before the window', timestamp: from - HOUR }),
        historyEntry({ prompt: 'newest is inside', timestamp: to - HOUR }),
      ],
      { summary: 'Active work.' },
    )

    const selection = await query({
      range: { from: '2026-11-23T10:00:00', to: '2026-11-24T10:00:00' },
    })

    expect(selection.window).toEqual({ from, to })
    expect(selection.sessions.map((session) => session.id)).toEqual([active])
    expect(selection.sessions.map((session) => session.id)).not.toContain(quietSince)
  })

  it('is from-inclusive and to-exclusive on that newest entry', async () => {
    const from = new Date(2026, 10, 24, 10).getTime()
    const to = new Date(2026, 10, 24, 12).getTime()
    const atFrom = await seedSession([historyEntry({ timestamp: from })], { summary: 'At from.' })
    const justBefore = await seedSession([historyEntry({ timestamp: from - 1 })], {
      summary: 'Just before.',
    })
    const atTo = await seedSession([historyEntry({ timestamp: to })], { summary: 'At to.' })
    const justBeforeTo = await seedSession([historyEntry({ timestamp: to - 1 })], {
      summary: 'Just before to.',
    })

    const selection = await query({
      range: { from: '2026-11-24T10:00:00', to: '2026-11-24T12:00:00' },
    })

    const ids = selection.sessions.map((session) => session.id)
    expect(ids).toContain(atFrom)
    expect(ids).toContain(justBeforeTo)
    expect(ids).not.toContain(justBefore)
    expect(ids).not.toContain(atTo)
  })

  it('orders by the newest activity, most recent first, whatever the Session order', async () => {
    const oldest = await seedSession([historyEntry({ timestamp: NOW - 8 * HOUR })], {
      summary: 'Oldest.',
    })
    const newest = await seedSession([historyEntry({ timestamp: NOW - HOUR })], {
      summary: 'Newest.',
    })
    const middle = await seedSession([historyEntry({ timestamp: NOW - 4 * HOUR })], {
      summary: 'Middle.',
    })

    const selection = await query()

    expect(selection.sessions.map((session) => session.id)).toEqual([newest, middle, oldest])
  })
})

describe('the cards', () => {
  it('carries each Session’s Title and its stored Overview Summary', async () => {
    const id = await seedSession([historyEntry({})], { summary: 'It built the asteroid field.' })
    await mutateSession(id, (file) => ({ ...file, title: 'Space Dodger', renamed: true }))

    const [card] = (await query()).sessions

    expect(card).toMatchObject({
      id,
      title: 'Space Dodger',
      summary: 'It built the asteroid field.',
    })
  })

  it('falls back to the Title from the newest turn for a Session never renamed', async () => {
    await seedSession([historyEntry({ prompt: 'Tune the collision boxes' })], {
      summary: 'A tuning session.',
    })

    const [card] = (await query()).sessions

    expect(card.title).toBe('Tune the collision boxes')
  })

  it('takes the type icon from the stored picture, and from the output when there is none', async () => {
    const pictured = await seedSession([historyEntry({ kind: 'chat' })], {
      summary: 'A picture.',
      summaryPicture: { path: 'files/a.png', mediaType: 'image', source: 'artifact' },
    })
    const video = await seedSession(
      [historyEntry({ kind: 'video', preset: 'Video', timestamp: NOW - 2 * HOUR })],
      { summary: 'A video.' },
    )
    const speech = await seedSession(
      [historyEntry({ kind: 'tts', preset: 'Text to Speech', timestamp: NOW - 3 * HOUR })],
      { summary: 'Speech.' },
    )
    const chat = await seedSession([historyEntry({ timestamp: NOW - 4 * HOUR })], {
      summary: 'A chat.',
    })

    const icons = new Map((await query()).sessions.map((card) => [card.id, card.icon]))

    expect(icons.get(pictured)).toBe('🎨')
    expect(icons.get(video)).toBe('🎬')
    expect(icons.get(speech)).toBe('🔊')
    expect(icons.get(chat)).toBe('💬')
  })

  it('carries no History Entries or turn text, only the stored account', async () => {
    const id = await seedSession([historyEntry({ prompt: 'a secret prompt' })], {
      summary: 'The account.',
    })
    await mutateSession(id, (file) => ({ ...file, title: 'The project', renamed: true }))

    const [card] = (await query()).sessions

    expect(Object.keys(card).sort()).toEqual(['counts', 'icon', 'id', 'summary', 'title'])
    expect(JSON.stringify(card)).not.toContain('a secret prompt')
  })

  it('folds the whole Session’s work even when only its newest entry is in the window', async () => {
    const from = new Date(2026, 10, 23, 10).getTime()
    const to = new Date(2026, 10, 24, 10).getTime()
    const id = await seedSession(
      [
        historyEntry({
          timestamp: from - HOUR,
          artifacts: [
            { path: 'a.png', mediaType: 'image' },
            { path: 'b.png', mediaType: 'image' },
          ],
        }),
        historyEntry({ kind: 'stt', timestamp: from - 2 * HOUR }),
        historyEntry({ timestamp: to - HOUR }),
      ],
      { summary: 'A windowed card.' },
    )

    const [card] = (
      await query({ range: { from: '2026-11-23T10:00:00', to: '2026-11-24T10:00:00' } })
    ).sessions

    expect(card.id).toBe(id)
    expect(card.counts).toMatchObject({
      images: 2,
      transcriptions: 1,
      videos: 0,
      agentRuns: 0,
    })
  })
})

describe('omitted and behind Sessions', () => {
  it('omits an active included Session with no usable summary and names its Title', async () => {
    const usable = await seedSession([historyEntry({ timestamp: NOW - HOUR })], {
      summary: 'Current account.',
    })
    const missing = await seedSession([historyEntry({ timestamp: NOW - 2 * HOUR })])
    await mutateSession(missing, (file) => ({
      ...file,
      title: 'No Summary Yet',
      renamed: true,
    }))

    const selection = await query()

    expect(selection.outcome).toBe('ok')
    expect(selection.sessions.map((session) => session.id)).toEqual([usable])
    expect(selection.omitted).toEqual(['No Summary Yet'])
    expect(selection.behind).toEqual([])
  })

  it('includes a failed or pending summary that still has text, marked behind', async () => {
    const failed = await seedSession([historyEntry({ timestamp: NOW - HOUR })], {
      summary: 'Stale text kept from before the failure.',
      summaryState: 'failed',
    })
    const pending = await seedSession([historyEntry({ timestamp: NOW - 2 * HOUR })], {
      summary: 'Text from the last successful run.',
      summaryState: 'pending',
    })
    for (const [id, title] of [
      [failed, 'Failed Update'],
      [pending, 'Pending Update'],
    ] as const) {
      await mutateSession(id, (file) => ({ ...file, title, renamed: true }))
    }

    const selection = await query()

    expect(selection.outcome).toBe('ok')
    expect(selection.sessions.map((session) => session.id)).toEqual([failed, pending])
    expect(selection.behind).toEqual(['Failed Update', 'Pending Update'])
    expect(selection.omitted).toEqual([])
    expect(selection.sessions.map((session) => session.summary)).toEqual([
      'Stale text kept from before the failure.',
      'Text from the last successful run.',
    ])
  })

  it('omits a failed or pending summary only when it has no text', async () => {
    const failed = await seedSession([historyEntry({ timestamp: NOW - HOUR })])
    const pending = await seedSession([historyEntry({ timestamp: NOW - 2 * HOUR })])
    await mutateSession(failed, (file) => ({
      ...file,
      title: 'Failed Update',
      renamed: true,
      overviewSummary: { state: 'failed', contractVersion: 1 },
    }))
    await mutateSession(pending, (file) => ({
      ...file,
      title: 'Pending Update',
      renamed: true,
      overviewSummary: { state: 'pending', contractVersion: 1 },
    }))

    const selection = await query()

    expect(selection.outcome).toBe('none-usable')
    expect(selection.sessions).toEqual([])
    expect(selection.omitted).toEqual(['Failed Update', 'Pending Update'])
  })

  it('treats an old contract version as behind even when it covers the newest entry', async () => {
    const id = await seedSession([historyEntry({ timestamp: NOW - HOUR })], {
      summary: 'Written by an older contract.',
    })
    await mutateSession(id, (file) => ({
      ...file,
      title: 'Old Contract',
      renamed: true,
      overviewSummary: file.overviewSummary && {
        ...file.overviewSummary,
        contractVersion: 999,
      },
    }))

    const selection = await query()

    expect(selection.outcome).toBe('ok')
    expect(selection.sessions.map((session) => session.id)).toEqual([id])
    expect(selection.sessions[0]?.summary).toBe('Written by an older contract.')
    expect(selection.behind).toEqual(['Old Contract'])
  })

  it('includes a Session whose summary is behind its newest entry, and names its Title', async () => {
    const older = historyEntry({ timestamp: NOW - 3 * HOUR })
    const newer = historyEntry({ timestamp: NOW - HOUR })
    const id = await seedSession([older, newer], {
      summary: 'Account through the older turn.',
      summaryCovers: older.id,
    })
    await mutateSession(id, (file) => ({ ...file, title: 'Behind Session', renamed: true }))

    const selection = await query()

    expect(selection.outcome).toBe('ok')
    expect(selection.sessions.map((session) => session.id)).toEqual([id])
    expect(selection.sessions[0]?.summary).toBe('Account through the older turn.')
    expect(selection.behind).toEqual(['Behind Session'])
    expect(selection.omitted).toEqual([])
  })

  it('does not call a summary that covers the newest entry behind', async () => {
    const id = await seedSession([historyEntry({ timestamp: NOW - HOUR })], {
      summary: 'Current account.',
    })

    const selection = await query()

    expect(selection.sessions.map((session) => session.id)).toEqual([id])
    expect(selection.behind).toEqual([])
  })

  it('reports no usable summary as its own outcome, naming every omitted Session', async () => {
    const one = await seedSession([historyEntry({ timestamp: NOW - HOUR })])
    const two = await seedSession([historyEntry({ timestamp: NOW - 2 * HOUR })])
    await mutateSession(one, (file) => ({ ...file, title: 'First Quiet', renamed: true }))
    await mutateSession(two, (file) => ({ ...file, title: 'Second Quiet', renamed: true }))

    const selection = await query()

    expect(selection.outcome).toBe('none-usable')
    expect(selection.sessions).toEqual([])
    expect(selection.omitted).toEqual(['First Quiet', 'Second Quiet'])
    expect(selection.message).toMatch(/usable Overview Summary/i)
  })
})

describe('the empty cases', () => {
  it('says nothing is included at all', async () => {
    await seedSession([historyEntry({})], { included: false })

    const selection = await query()

    expect(selection.outcome).toBe('none-included')
    expect(selection.includedSessions).toBe(0)
    expect(selection.sessions).toEqual([])
    expect(selection.message).toMatch(/included in Overviews/i)
    expect(selection.window).toBeDefined()
  })

  it('tells quiet included Sessions from none at all', async () => {
    await seedSession([historyEntry({ timestamp: NOW - 10 * DAY })])

    const selection = await query()

    expect(selection.outcome).toBe('none-in-range')
    expect(selection.includedSessions).toBe(1)
    expect(selection.sessions).toEqual([])
    expect(selection.message).toMatch(/active/i)
    expect(selection.message).not.toMatch(/included in Overviews/i)
  })

  it('counts a Session with no History Entries as quiet, not active', async () => {
    const empty = await createSession()
    await mutateSession(empty.id, (file) => ({ ...file, includedInOverviews: true }))

    const selection = await query()

    expect(selection.outcome).toBe('none-in-range')
    expect(selection.sessions).toEqual([])
  })
})
