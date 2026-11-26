import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverviewChrome } from '@/types/overviewChrome'

// The Overview capability's one tool: the agent translates a timeframe, calls it
// once, and relays the window and link. It never chooses a Session, writes a
// summary or markup; the page is built from the Sessions' stored Overview
// Summaries inside the asking Session's Workspace.

const dirs = vi.hoisted(() => ({ real: '', demo: '', games: '', mediaRecords: '' }))
const preview = vi.hoisted(() => ({ root: '', base: '' }))

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

vi.mock('../../agent/piWorkspaceRuntime.ts', () => ({
  workspacePreviewRoot: () => preview.root || null,
  resolvePreviewUrl: (url: string | undefined) =>
    url && preview.base ? new URL(url, preview.base).toString() : url,
  sameFolder: (a: string, b: string) => path.resolve(a) === path.resolve(b),
}))

const { overviewCapability } = await import('../../agent/capabilities/overview.ts')
const { mutateSession, resetSessionsForTest, setSessionDeps } =
  await import('../../session/sessions')
const {
  NOW,
  HOUR,
  DAY,
  TODAY,
  historyEntry,
  seedSession,
  hostFor: fixtureHostFor,
  textOf,
  toolNamed,
} = await import('../overviewFixtures')

const MINUTE = 60 * 1000

const CHROME: OverviewChrome = {
  locale: 'en-US',
  strings: {
    OVERVIEW_PAGE_TITLE: 'Sessions active {from} to {to}',
    OVERVIEW_OMITTED_NOTE: 'Omitted: {sessions}',
    OVERVIEW_BEHIND_NOTE: 'Behind: {sessions}',
    OVERVIEW_COUNT_IMAGES: 'Images',
    OVERVIEW_COUNT_VIDEOS: 'Videos',
    OVERVIEW_COUNT_MODELS_3D: '3D models',
    OVERVIEW_COUNT_AUDIO: 'Audio clips',
    OVERVIEW_COUNT_TRANSCRIPTIONS: 'Transcriptions',
    OVERVIEW_COUNT_AGENT_RUNS: 'Agent runs',
  },
}

type Host = Parameters<NonNullable<typeof overviewCapability.buildTools>>[0]

type Tool = {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

function hostFor(
  overrides: { sessionRef?: string | null; overviewChrome?: OverviewChrome | null } = {},
): Host {
  const host = fixtureHostFor({
    workspaceDir: path.join(dirs.real, 'workspace'),
    agentDir: dirs.real,
    sessionRef: overrides.sessionRef,
    responseLocale: 'en-US',
    ...(overrides.overviewChrome === null
      ? {}
      : { overviewChrome: overrides.overviewChrome ?? CHROME }),
  })
  return host
}

async function tool(host: Host = hostFor()): Promise<Tool> {
  return toolNamed(await overviewCapability.buildTools!(host), 'overview') as unknown as Tool
}

async function call(host: Host, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  return JSON.parse(textOf(await (await tool(host)).execute('call-1', params))) as Record<
    string,
    unknown
  >
}

async function callText(host: Host, params: Record<string, unknown>): Promise<string> {
  return textOf(await (await tool(host)).execute('call-1', params))
}

async function htmlFiles(): Promise<string[]> {
  return (await fs.readdir(path.join(dirs.real, 'workspace')).catch(() => [])).filter((file) =>
    file.endsWith('.html'),
  )
}

async function htmlAt(fileName: unknown): Promise<string> {
  return fs.readFile(path.join(dirs.real, 'workspace', String(fileName)), 'utf8')
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-overview-tool-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.games = path.join(root, 'games')
  dirs.mediaRecords = path.join(root, 'media-records')
})

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  preview.root = ''
  preview.base = ''
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(path.join(dirs.real, 'workspace'), { recursive: true })
})

afterEach(async () => {
  vi.useRealTimers()
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.games, { recursive: true, force: true })
})

describe('the overview capability', () => {
  it('exposes exactly one tool, and no summary, cover or session parameter', async () => {
    expect(overviewCapability.id).toBe('overview')
    const tools = await overviewCapability.buildTools!(hostFor())
    expect(tools.map((candidate) => candidate.name)).toEqual(['overview'])

    const parameters = (await tool()) as unknown as {
      parameters: { properties: Record<string, unknown> }
    }
    expect(Object.keys(parameters.parameters.properties).sort()).toEqual([
      'from',
      'lastHours',
      'lastMinutes',
      'range',
      'to',
    ])
    expect(overviewCapability.summary).toMatch(/Included in Overviews/)
  })
})

describe('the window', () => {
  it('resolves every named range and echoes the concrete window and its label', async () => {
    await seedSession([historyEntry({ timestamp: NOW - HOUR })])

    const last24 = await call(hostFor(), { range: 'last-24h' })
    expect(last24.window).toEqual({ from: NOW - DAY, to: NOW })
    expect(String(last24.windowLabel)).toMatch(/2026/)

    const today = await call(hostFor(), { range: 'today' })
    expect(today.window).toEqual({ from: TODAY, to: TODAY + DAY })

    const yesterday = await call(hostFor(), { range: 'yesterday' })
    expect(yesterday.window).toEqual({ from: TODAY - DAY, to: TODAY })

    const week = await call(hostFor(), { range: 'last-7-days' })
    expect(week.window).toEqual({ from: TODAY - 6 * DAY, to: NOW })

    const month = await call(hostFor(), { range: 'last-30-days' })
    expect(month.window).toEqual({ from: TODAY - 29 * DAY, to: NOW })
  })

  it('takes a number of minutes the user named, never as hours', async () => {
    await seedSession([historyEntry({ timestamp: NOW - HOUR })])

    const data = await call(hostFor(), { lastMinutes: 10 })
    expect(data.window).toEqual({ from: NOW - 10 * MINUTE, to: NOW })

    const stringy = await call(hostFor(), { lastMinutes: '15' })
    expect(stringy.window).toEqual({ from: NOW - 15 * MINUTE, to: NOW })
  })

  it('prefers a minute count when a model fills both fields', async () => {
    await seedSession([historyEntry({ timestamp: NOW - HOUR })])

    const data = await call(hostFor(), { lastHours: 3, lastMinutes: 10 })
    expect(data.window).toEqual({ from: NOW - 10 * MINUTE, to: NOW })
  })

  it('takes a number of hours the user named', async () => {
    await seedSession([historyEntry({ timestamp: NOW - HOUR })])

    const data = await call(hostFor(), { lastHours: 12 })
    expect(data.window).toEqual({ from: NOW - 12 * HOUR, to: NOW })

    const day = await call(hostFor(), { lastHours: 24 })
    const named = await call(hostFor(), { range: 'last-24h' })
    expect(day.window).toEqual(named.window)
  })

  it('accepts a kind tag in range beside the real field, and ignores its case', async () => {
    await seedSession([historyEntry({ timestamp: NOW - HOUR })])

    const tagged = await call(hostFor(), { range: 'lastHours', lastHours: 1 })
    expect(tagged.window).toEqual({ from: NOW - HOUR, to: NOW })

    const upper = await call(hostFor(), { range: 'LAST-24H' })
    expect(upper.window).toEqual({ from: NOW - DAY, to: NOW })
  })

  it('accepts a window a model sent as a JSON string or a string number', async () => {
    await seedSession([historyEntry({ timestamp: NOW - HOUR })])

    const nested = await call(hostFor(), { range: JSON.stringify({ lastHours: 2 }) })
    expect(nested.window).toEqual({ from: NOW - 2 * HOUR, to: NOW })

    const stringy = await call(hostFor(), { lastHours: '3' })
    expect(stringy.window).toEqual({ from: NOW - 3 * HOUR, to: NOW })
  })

  it('answers a nonsense range as text, not a thrown error', async () => {
    for (const params of [
      { range: 'since forever' },
      { lastHours: 0 },
      { lastHours: 1.5 },
      { lastHours: 9000 },
      { lastMinutes: 0 },
      { lastMinutes: 2.5 },
      { lastMinutes: 1441 },
    ]) {
      expect(await callText(hostFor(), params)).toMatch(/range|date|hour|minute/i)
    }
  })

  it('uses from-inclusive and to-exclusive bounds on the newest Entry', async () => {
    const from = new Date(2026, 10, 24, 10).getTime()
    const to = new Date(2026, 10, 24, 12).getTime()
    const included = await seedSession([historyEntry({ timestamp: from })], {
      summary: 'Started at the boundary.',
    })
    const excluded = await seedSession([historyEntry({ timestamp: to })], {
      summary: 'Started at the end.',
    })

    const result = await call(hostFor(), {
      from: '2026-11-24T10:00:00',
      to: '2026-11-24T12:00:00',
    })
    const html = await htmlAt(result.path)

    expect(html).toContain('Started at the boundary.')
    expect(html).not.toContain('Started at the end.')
    expect(included).toBeTruthy()
    expect(excluded).toBeTruthy()
  })
})

describe('the page', () => {
  it('writes the range-named file into the Workspace and returns only the facts', async () => {
    const id = await seedSession([historyEntry({ timestamp: NOW - HOUR })], {
      summary: 'It shipped the thing and fixed two bugs.',
    })
    await mutateSession(id, (file) => ({ ...file, title: 'Shipped the thing', renamed: true }))

    const result = await call(hostFor(), { range: 'last-24h' })

    expect(result).toEqual({
      written: true,
      path: 'overview-2026-11-23_1530..2026-11-24_1530.html',
      window: { from: NOW - DAY, to: NOW },
      windowLabel: expect.any(String),
      omittedCount: 0,
      behindCount: 0,
    })
    expect(Object.keys(result).sort()).toEqual([
      'behindCount',
      'omittedCount',
      'path',
      'window',
      'windowLabel',
      'written',
    ])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('It shipped the thing')
    expect(serialized).not.toContain('Shipped the thing')

    const html = await htmlAt(result.path)
    expect(html).toContain('<h1>Sessions active 2026-11-23 15:30 to 2026-11-24 15:30</h1>')
    expect(html).toContain(
      '<p class="title"><span class="icon" aria-hidden="true">💬</span>Shipped the thing</p>',
    )
    expect(html).toContain('<p class="summary">It shipped the thing and fixed two bugs.</p>')
    // No pictures yet, and no turn or prompt text.
    expect(html).not.toMatch(/<img\b/)
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toContain('class="turn"')
  })

  it('renders the stored summaries of every active included Session, in the app’s order', async () => {
    const newest = await seedSession([historyEntry({ timestamp: NOW - HOUR })], {
      summary: 'Newest work.',
    })
    const oldest = await seedSession([historyEntry({ timestamp: NOW - 5 * HOUR })], {
      summary: 'Oldest work.',
    })
    await mutateSession(newest, (file) => ({ ...file, title: 'Newest Session', renamed: true }))
    await mutateSession(oldest, (file) => ({ ...file, title: 'Oldest Session', renamed: true }))

    const result = await call(hostFor(), { range: 'last-24h' })
    const html = await htmlAt(result.path)

    expect(html.match(/<article class="card">/g)).toHaveLength(2)
    expect(html.indexOf('Newest Session')).toBeLessThan(html.indexOf('Oldest Session'))
    expect(html).toContain('Newest work.')
    expect(html).toContain('Oldest work.')
  })

  it('leaves out the Session that asked and every Session not included', async () => {
    const asking = await seedSession([historyEntry({})], { summary: 'Asking.' })
    const included = await seedSession([historyEntry({ timestamp: NOW - HOUR })], {
      summary: 'Included.',
    })
    await seedSession([historyEntry({ timestamp: NOW - 2 * HOUR })], {
      included: false,
      summary: 'Not included.',
    })

    const result = await call(hostFor({ sessionRef: asking }), { range: 'last-24h' })
    const html = await htmlAt(result.path)

    expect(html).toContain('Included.')
    expect(html).not.toContain('Asking.')
    expect(html).not.toContain('Not included.')
    expect(included).toBeTruthy()
  })

  it('escapes Titles and summaries containing markup', async () => {
    const id = await seedSession([historyEntry({})], {
      summary: 'It shipped </p><script>alert(1)</script> the thing.',
    })
    await mutateSession(id, (file) => ({
      ...file,
      title: '<b>Bold</b> & "quoted"',
      renamed: true,
    }))

    const result = await call(hostFor(), { range: 'last-24h' })
    const html = await htmlAt(result.path)

    expect(html).toContain('&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot;')
    expect(html).toContain('It shipped &lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt; the thing.')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toContain('<b>Bold</b>')
  })

  it('replaces the same range and leaves a different range alone', async () => {
    const dayOne = await seedSession(
      [historyEntry({ timestamp: new Date(2026, 10, 22, 12).getTime() })],
      {
        summary: 'First summary.',
      },
    )
    await seedSession([historyEntry({ timestamp: new Date(2026, 10, 23, 12).getTime() })], {
      summary: 'Second day.',
    })
    const firstWindow = { from: '2026-11-22', to: '2026-11-23' }
    const secondWindow = { from: '2026-11-23', to: '2026-11-24' }

    const first = await call(hostFor(), firstWindow)
    expect(await htmlAt(first.path)).toContain('First summary.')

    await mutateSession(dayOne, (file) => ({
      ...file,
      overviewSummary: { state: 'ready', contractVersion: 1, text: 'Rewritten summary.' },
    }))
    const rewritten = await call(hostFor(), firstWindow)
    expect(rewritten.path).toBe(first.path)
    const rewrittenHtml = await htmlAt(first.path)
    expect(rewrittenHtml).toContain('Rewritten summary.')
    expect(rewrittenHtml).not.toContain('First summary.')

    const second = await call(hostFor(), secondWindow)
    expect(second.path).not.toBe(first.path)
    expect(await htmlFiles()).toHaveLength(2)
    expect(await htmlAt(first.path)).toBe(rewrittenHtml)
  })

  it('returns the preview URL only when that server is serving the Workspace', async () => {
    await seedSession([historyEntry({})], { summary: 'A day.' })

    preview.root = path.join(dirs.real, 'somewhere-else')
    preview.base = 'http://127.0.0.1:4711/'
    const elsewhere = await call(hostFor(), { range: 'last-24h' })
    expect(elsewhere.written).toBe(true)
    expect(elsewhere.url).toBeUndefined()

    preview.root = path.join(dirs.real, 'workspace')
    const served = await call(hostFor(), { range: 'last-24h' })
    expect(served.url).toBe('http://127.0.0.1:4711/overview-2026-11-23_1530..2026-11-24_1530.html')
  })

  it('uses the reader’s locale for its chrome and label', async () => {
    await seedSession([historyEntry({})], { summary: 'Ein Tag.' })
    const chrome: OverviewChrome = {
      locale: 'de',
      strings: {
        OVERVIEW_PAGE_TITLE: 'Aktive Sitzungen {from} bis {to}',
        OVERVIEW_OMITTED_NOTE: 'Ausgelassen: {sessions}',
        OVERVIEW_BEHIND_NOTE: 'Zurück: {sessions}',
        OVERVIEW_COUNT_IMAGES: 'Bilder',
        OVERVIEW_COUNT_VIDEOS: 'Videos',
        OVERVIEW_COUNT_MODELS_3D: '3D-Modelle',
        OVERVIEW_COUNT_AUDIO: 'Audioclips',
        OVERVIEW_COUNT_TRANSCRIPTIONS: 'Transkriptionen',
        OVERVIEW_COUNT_AGENT_RUNS: 'Agentenläufe',
      },
    }

    const result = await call(hostFor({ overviewChrome: chrome }), { range: 'last-24h' })
    const html = await htmlAt(result.path)

    expect(html).toContain('<html lang="de">')
    expect(html).toContain('<h1>Aktive Sitzungen 2026-11-23 15:30 bis 2026-11-24 15:30</h1>')
    expect(String(result.windowLabel)).not.toMatch(/\d{2}:\d{2} (AM|PM)/)
  })
})

describe('the work counts', () => {
  it('renders the whole Session’s counts on the card even when only its newest entry is in the window', async () => {
    const older = historyEntry({
      timestamp: NOW - 2 * DAY,
      status: 'failed',
      artifacts: [
        { path: 'a.png', mediaType: 'image' },
        { path: 'b.png', mediaType: 'image' },
      ],
    })
    const newest = historyEntry({ timestamp: NOW - HOUR })
    const id = await seedSession([older, newest], { summary: 'It produced things.' })
    await mutateSession(id, (file) => ({ ...file, title: 'Producer', renamed: true }))

    const result = await call(hostFor(), { range: 'last-24h' })
    const html = await htmlAt(result.path)

    expect(html).toContain('<div class="counts">')
    expect(html).toMatch(/Images<\/span><span class="count-value">2</)
    expect(html).not.toContain('Videos')
  })

  it('returns no counts, History Entries or summaries to the model', async () => {
    const id = await seedSession(
      [
        historyEntry({
          prompt: 'a secret prompt',
          artifacts: [{ path: 'a.png', mediaType: 'image' }],
        }),
      ],
      { summary: 'A stored account.' },
    )
    await mutateSession(id, (file) => ({ ...file, title: 'Secret Session', renamed: true }))

    const result = await call(hostFor(), { range: 'last-24h' })
    const keys = Object.keys(result)

    expect(keys).not.toContain('counts')
    expect(keys).not.toContain('workCounts')
    for (const category of [
      'images',
      'videos',
      'models3d',
      'audio',
      'transcriptions',
      'agentRuns',
    ]) {
      expect(keys).not.toContain(category)
    }
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('a secret prompt')
    expect(serialized).not.toContain('A stored account.')
    expect(serialized).not.toContain('Secret Session')
  })
})

describe('omitted and behind Sessions', () => {
  it('names omitted and behind Sessions in the result and on the page', async () => {
    const usable = await seedSession([historyEntry({ timestamp: NOW - HOUR })], {
      summary: 'Current account.',
    })
    await mutateSession(usable, (file) => ({ ...file, title: 'Current Session', renamed: true }))

    const missing = await seedSession([
      historyEntry({ prompt: 'private prompt text', timestamp: NOW - 2 * HOUR }),
    ])
    await mutateSession(missing, (file) => ({ ...file, title: 'No Summary', renamed: true }))

    const older = historyEntry({ timestamp: NOW - 4 * HOUR })
    const newer = historyEntry({ timestamp: NOW - 3 * HOUR })
    const behind = await seedSession([older, newer], {
      summary: 'Older account.',
      summaryCovers: older.id,
    })
    await mutateSession(behind, (file) => ({ ...file, title: 'Behind Session', renamed: true }))

    const result = await call(hostFor(), { range: 'last-24h' })

    expect(result).toMatchObject({ written: true, omittedCount: 1, behindCount: 1 })
    expect(result.omitted).toEqual(['No Summary'])
    expect(result.behind).toEqual(['Behind Session'])

    const html = await htmlAt(result.path)
    expect(html.match(/<article class="card">/g)).toHaveLength(2)
    expect(html).toContain('Omitted: No Summary')
    expect(html).toContain('Behind: Behind Session')
    expect(html).not.toContain('private prompt text')
  })

  it('writes no file and explains when no active Session has a usable summary', async () => {
    const id = await seedSession([historyEntry({ prompt: 'draft prompt', timestamp: NOW - HOUR })])
    await mutateSession(id, (file) => ({ ...file, title: 'Draft Only', renamed: true }))

    const result = await call(hostFor(), { range: 'last-24h' })

    expect(result).toMatchObject({
      written: false,
      outcome: 'none-usable',
      omittedCount: 1,
      behindCount: 0,
    })
    expect(result.omitted).toEqual(['Draft Only'])
    expect(String(result.message)).toMatch(/usable Overview Summary/i)
    expect(result.path).toBeUndefined()
    expect(await htmlFiles()).toEqual([])
  })
})

describe('the empty outcomes', () => {
  it('writes no file when no Session is included, and names the reason', async () => {
    await seedSession([historyEntry({})], { included: false })

    const result = await call(hostFor(), { range: 'last-24h' })

    expect(result).toMatchObject({ written: false, outcome: 'none-included' })
    expect(String(result.message)).toMatch(/included in Overviews/i)
    expect(result.path).toBeUndefined()
    expect(await htmlFiles()).toEqual([])
  })

  it('writes no file when included Sessions were quiet, and names the other reason', async () => {
    await seedSession([historyEntry({ timestamp: NOW - 10 * DAY })])

    const result = await call(hostFor(), { range: 'last-24h' })

    expect(result).toMatchObject({ written: false, outcome: 'none-in-range' })
    expect(String(result.message)).toMatch(/active/i)
    expect(result.path).toBeUndefined()
    expect(await htmlFiles()).toEqual([])
  })
})

describe('the refusing cases', () => {
  it('refuses a Trial Run with no Session to write into, and writes nothing', async () => {
    await seedSession([historyEntry({})], { summary: 'A day.' })

    const text = await callText(hostFor({ sessionRef: null }), { range: 'last-24h' })

    expect(text).toMatch(/not attached to a Session/i)
    expect(await htmlFiles()).toEqual([])
  })

  it('refuses when the chrome did not reach the turn instead of rendering a raw key', async () => {
    await seedSession([historyEntry({})], { summary: 'A day.' })

    const text = await callText(hostFor({ overviewChrome: null }), { range: 'last-24h' })

    expect(text).toMatch(/Overview language/i)
    expect(text).not.toContain('OVERVIEW_PAGE_TITLE')
    expect(await htmlFiles()).toEqual([])
  })
})
