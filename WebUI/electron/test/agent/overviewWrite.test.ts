import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverviewChrome } from '@/types/overviewChrome'

// The `overview_write` tool is the deliverable: it re-runs the query, renders the
// page from code and writes one file into the reporting Session's Workspace. The
// page itself is the pure renderer's job (overviewHtml.test.ts); here the file and
// the tool's answer are what matter.

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
const {
  createSession,
  mutateSession,
  resetSessionsForTest,
  sessionPaths,
  setSessionDeps,
  setSessionIncludedInOverviews,
} = await import('../../session/sessions')
const { writeHistoryLines } = await import('../../persist/sessionFiles')
const { OVERVIEW_CHROME_KEYS } = await import('@/types/overviewChrome')
const {
  NOW,
  HOUR,
  DAY,
  historyEntry,
  seedSession,
  hostFor: fixtureHostFor,
  textOf,
  toolNamed,
  write: writeJson,
} = await import('../overviewFixtures')

const CHROME: OverviewChrome = {
  locale: 'en-US',
  strings: Object.fromEntries(
    OVERVIEW_CHROME_KEYS.map((key) => [key, key]),
  ) as OverviewChrome['strings'],
}

type Host = Parameters<NonNullable<typeof overviewCapability.buildTools>>[0]

type Tool = {
  name: string
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

function hostFor(
  overrides: {
    sessionRef?: string | null
    responseLocale?: string
    overviewChrome?: OverviewChrome
  } = {},
): Host {
  return fixtureHostFor({
    workspaceDir: path.join(dirs.real, 'workspace'),
    agentDir: dirs.real,
    sessionRef: overrides.sessionRef,
    overviewChrome: overrides.overviewChrome ?? CHROME,
    responseLocale: overrides.responseLocale ?? 'en-US',
  })
}

async function writeTool(host: Host): Promise<Tool> {
  return toolNamed(await overviewCapability.buildTools!(host), 'overview_write')
}

async function write(
  host: Host,
  range: unknown,
  opening = 'A short opening.',
): Promise<Record<string, unknown>> {
  return writeJson(await writeTool(host), { range, opening })
}

async function seedPictureSession(
  key: string,
  time = NOW - HOUR,
): Promise<{ id: string; path: string }> {
  const { id } = await createSession()
  const picturePath = path.join(sessionPaths(id).filesDir, `${key}.png`)
  await fs.mkdir(path.dirname(picturePath), { recursive: true })
  await fs.writeFile(picturePath, key)
  await writeHistoryLines(id, [
    JSON.stringify(
      historyEntry({
        kind: 'image',
        preset: 'Image Gen',
        prompt: key,
        timestamp: time,
        artifacts: [{ path: `files/${key}.png`, mediaType: 'image' }],
      }),
    ),
  ])
  await mutateSession(id, (file) => ({ ...file, updatedAt: time }))
  await setSessionIncludedInOverviews(id, true)
  return { id, path: picturePath }
}

async function writeText(
  host: Host,
  range: unknown,
  opening: string,
  covers?: Record<string, string>,
): Promise<string> {
  return textOf(
    await (
      await writeTool(host)
    ).execute('call-1', {
      range,
      opening,
      ...(covers ? { covers } : {}),
    }),
  )
}

async function htmlFiles(): Promise<string[]> {
  return (await fs.readdir(path.join(dirs.real, 'workspace')).catch(() => [])).filter((file) =>
    file.endsWith('.html'),
  )
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-overview-write-'))
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

describe('overview_write', () => {
  it('is the second tool of the overview capability', async () => {
    const tools = await overviewCapability.buildTools!(hostFor())
    expect(tools.map((tool) => tool.name)).toEqual(['overview_data', 'overview_write'])
  })

  it('writes the range-named file into the Workspace and returns the facts', async () => {
    await seedSession([historyEntry({ prompt: 'shipped <b>the</b> thing', timestamp: NOW - HOUR })])
    const host = hostFor()

    const result = await write(host, 'last-24h', 'A quiet day.')

    expect(result).toMatchObject({
      written: true,
      path: 'overview-2026-11-23_1530..2026-11-24_1530.html',
      window: { from: NOW - DAY, to: NOW },
      sessions: 1,
      truncated: false,
    })
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('A quiet day.')
    expect(html).toContain('shipped &lt;b&gt;the&lt;/b&gt; thing')
    expect(html).not.toMatch(/<script/i)
  })

  it('returns the live preview URL only when it serves this Workspace', async () => {
    await seedSession([historyEntry({})])
    const host = hostFor()

    preview.root = path.join(dirs.real, 'somewhere-else')
    preview.base = 'http://127.0.0.1:4711/'
    const elsewhere = await write(host, 'last-24h')
    expect(elsewhere.written).toBe(true)
    expect(elsewhere.path).toBe('overview-2026-11-23_1530..2026-11-24_1530.html')
    expect(elsewhere.url).toBeUndefined()

    preview.root = host.workspaceDir
    preview.base = 'http://127.0.0.1:4711/'
    const served = await write(host, 'last-24h')
    expect(served.url).toBe('http://127.0.0.1:4711/overview-2026-11-23_1530..2026-11-24_1530.html')
  })

  it('replaces the same range and leaves a different range alone', async () => {
    await seedSession([
      historyEntry({ prompt: 'yesterday work', timestamp: new Date(2026, 10, 23, 10).getTime() }),
      historyEntry({ prompt: 'today work', timestamp: new Date(2026, 10, 24, 10).getTime() }),
    ])
    const host = hostFor()
    const yesterday = { from: '2026-11-23T00:00:00', to: '2026-11-24T00:00:00' }
    const today = { from: '2026-11-24T00:00:00', to: '2026-11-25T00:00:00' }

    const first = await write(host, yesterday, 'First opening.')
    const firstPath = path.join(host.workspaceDir, String(first.path))
    expect(await fs.readFile(firstPath, 'utf8')).toContain('First opening.')

    const rewritten = await write(host, yesterday, 'Rewritten opening.')
    expect(rewritten.path).toBe(first.path)
    const rewrittenHtml = await fs.readFile(firstPath, 'utf8')
    expect(rewrittenHtml).toContain('Rewritten opening.')
    expect(rewrittenHtml).not.toContain('First opening.')
    expect(await htmlFiles()).toHaveLength(1)

    const other = await write(host, today, 'Another opening.')
    expect(other.path).not.toBe(first.path)
    expect(await htmlFiles()).toHaveLength(2)
    expect(await fs.readFile(firstPath, 'utf8')).toBe(rewrittenHtml)
  })

  it('refuses "nothing is included", writes no file, and names the reason', async () => {
    await seedSession([historyEntry({})], { included: false })
    const host = hostFor()

    const result = await write(host, 'last-24h')

    expect(result).toMatchObject({ written: false, outcome: 'none-included' })
    expect(String(result.message)).toMatch(/included in Overviews/i)
    expect(await htmlFiles()).toEqual([])
  })

  it('refuses "included but quiet", writes no file, and names the other reason', async () => {
    await seedSession([historyEntry({ timestamp: NOW - 10 * DAY })])
    const host = hostFor()

    const result = await write(host, 'last-24h')

    expect(result).toMatchObject({ written: false, outcome: 'none-in-range' })
    expect(String(result.message)).toMatch(/no turn/i)
    expect(await htmlFiles()).toEqual([])
  })

  it('reports truncation and a shortened opening in the result', async () => {
    const entries = Array.from({ length: 45 }, (_, index) =>
      historyEntry({
        prompt: `turn ${index}`,
        timestamp: NOW - (45 - index) * 60_000,
      }),
    )
    await seedSession(entries)
    const host = hostFor()

    const result = await write(host, 'last-24h', 'x'.repeat(1500))

    expect(result).toMatchObject({
      written: true,
      truncated: true,
      shownEntries: 40,
      totalEntries: 45,
      openingTruncated: { shown: 1200, total: 1500 },
    })
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('OVERVIEW_REPORT_TRUNCATED')
    expect(html).toContain('OVERVIEW_SESSION_TRUNCATED')
  })

  it('reports the Sessions the line budget left out, and the page says so', async () => {
    for (let index = 0; index < 11; index++) {
      await seedSession(
        Array.from({ length: 40 }, (_, line) =>
          historyEntry({
            prompt: `session ${index} turn ${line}`,
            timestamp: NOW - (index + 1) * HOUR - line * 60_000,
          }),
        ),
        { updatedAt: NOW - index * HOUR },
      )
    }
    const host = hostFor()

    const result = await write(host, 'last-24h')

    expect(result).toMatchObject({
      written: true,
      sessions: 10,
      sessionsOmitted: 1,
      shownEntries: 400,
      totalEntries: 440,
      truncated: true,
    })
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('OVERVIEW_SESSIONS_OMITTED')
    expect(html.match(/<section class="session">/g)).toHaveLength(10)
  })

  it('renders the chrome strings the renderer shipped, with their locale', async () => {
    await seedSession([historyEntry({})])
    const host = hostFor({
      responseLocale: 'de',
      overviewChrome: {
        locale: 'de',
        strings: {
          ...CHROME.strings,
          OVERVIEW_PAGE_TITLE: 'Überblick: {from} bis {to}',
          OVERVIEW_RANGE: 'Von {from} bis {to}',
        },
      },
    })

    const result = await write(host, 'last-24h')
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('<html lang="de">')
    expect(html).toContain('Überblick: 2026-11-23 15:30 bis 2026-11-24 15:30')
  })

  it('refuses when the chrome did not reach the turn instead of rendering a raw key', async () => {
    await seedSession([historyEntry({})])
    const host = fixtureHostFor({
      workspaceDir: path.join(dirs.real, 'workspace'),
      agentDir: dirs.real,
    })

    const text = await writeText(host, 'last-24h', 'An opening.')

    expect(text).toMatch(/Overview language/i)
    expect(text).not.toContain('OVERVIEW_PAGE_TITLE')
    expect(await htmlFiles()).toEqual([])
  })

  it('refuses when the turn has no Session to exclude, and writes no file', async () => {
    await seedSession([historyEntry({})])

    const text = await writeText(hostFor({ sessionRef: null }), 'last-24h', 'An opening.')

    expect(text).toMatch(/not attached to a Session/i)
    expect(await htmlFiles()).toEqual([])
  })

  it("refuses a picture that is another Session's candidate", async () => {
    const first = await seedPictureSession('first-picture')
    const second = await seedPictureSession('second-picture')
    const host = hostFor()

    const text = await writeText(host, 'last-24h', 'An opening.', { [first.id]: second.path })

    expect(text).toMatch(/belongs to/i)
    expect(text).toContain(second.path)
    expect(await htmlFiles()).toEqual([])
  })

  it('refuses a picture from outside the range', async () => {
    const { id } = await createSession()
    const outsidePath = path.join(sessionPaths(id).filesDir, 'last-month.png')
    await fs.mkdir(path.dirname(outsidePath), { recursive: true })
    await fs.writeFile(outsidePath, 'old')
    await writeHistoryLines(id, [
      JSON.stringify(
        historyEntry({
          kind: 'image',
          preset: 'Image Gen',
          prompt: 'last month',
          timestamp: NOW - 10 * DAY,
          artifacts: [{ path: 'files/last-month.png', mediaType: 'image' }],
        }),
      ),
      JSON.stringify(historyEntry({ prompt: 'today', timestamp: NOW - HOUR })),
    ])
    await mutateSession(id, (file) => ({ ...file, updatedAt: NOW }))
    await setSessionIncludedInOverviews(id, true)
    const host = hostFor()

    const text = await writeText(host, 'last-24h', 'An opening.', { [id]: outsidePath })

    expect(text).toMatch(/no picture candidate/i)
    expect(text).toContain(outsidePath)
    expect(await htmlFiles()).toEqual([])
  })

  it('refuses a Session the Overview does not show', async () => {
    await seedPictureSession('shown')
    const quiet = await seedSession([historyEntry({ timestamp: NOW - 10 * DAY })])
    const host = hostFor()

    const text = await writeText(host, 'last-24h', 'An opening.', {
      [quiet]: path.join(dirs.real, 'anything.png'),
    })

    expect(text).toMatch(/no Session/i)
    expect(text).toContain(quiet)
    expect(await htmlFiles()).toEqual([])
  })
})
