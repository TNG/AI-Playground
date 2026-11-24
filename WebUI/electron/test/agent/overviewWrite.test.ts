import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverviewChrome } from '@/types/overviewChrome'

// The `overview_write` tool is the deliverable: it re-runs the query, renders the
// page from the agent's per-Session summaries and writes one file into the reporting
// Session's Workspace. The page itself is the pure renderer's job
// (overviewHtml.test.ts); here the file and the tool's answer are what matter.

const dirs = vi.hoisted(() => ({ real: '', demo: '', games: '', mediaRecords: '' }))
const preview = vi.hoisted(() => ({ root: '', base: '' }))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => dirs.real, getAppPath: () => dirs.real },
  BrowserWindow: class {},
  net: {},
  // The decoder stands in for `nativeImage`: its data URI names the file's bytes,
  // so a test can tell which candidate really reached the page.
  nativeImage: {
    createFromBuffer: (buffer: Buffer) => ({
      isEmpty: () => false,
      getSize: () => ({ width: 10, height: 10 }),
      toDataURL: () => `data:image/png;base64,${buffer.toString('base64')}`,
    }),
  },
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

async function dataTool(host: Host): Promise<Tool> {
  return toolNamed(await overviewCapability.buildTools!(host), 'overview_data')
}

type SummaryMap = Record<string, string>

async function write(
  host: Host,
  range: unknown,
  summaries: SummaryMap,
): Promise<Record<string, unknown>> {
  return writeJson(await writeTool(host), { range, summaries })
}

async function writeText(
  host: Host,
  range: unknown,
  summaries: SummaryMap,
  covers?: Record<string, string>,
): Promise<string> {
  return textOf(
    await (
      await writeTool(host)
    ).execute('call-1', {
      range,
      summaries,
      ...(covers ? { covers } : {}),
    }),
  )
}

/** The ids `overview_data` would show, so a test can summarise exactly those. */
async function shownIds(host: Host, range: unknown): Promise<string[]> {
  const data = JSON.parse(textOf(await (await dataTool(host)).execute('call-1', { range }))) as {
    sessions: { id: string }[]
  }
  return data.sessions.map((session) => session.id)
}

async function summariesFor(host: Host, range: unknown): Promise<SummaryMap> {
  const ids = await shownIds(host, range)
  return Object.fromEntries(ids.map((id) => [id, `What happened in ${id}.`]))
}

function handleOf(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
}

function pictureUri(key: string): string {
  return `data:image/png;base64,${Buffer.from(key).toString('base64')}`
}

async function titled(id: string, title: string): Promise<string> {
  await mutateSession(id, (file) => ({ ...file, title, renamed: true }))
  return id
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
    const id = await titled(
      await seedSession([historyEntry({ timestamp: NOW - HOUR })]),
      'Shipped the thing',
    )
    const host = hostFor()

    const result = await write(host, 'last-24h', { [id]: 'A quiet day.' })

    expect(result).toMatchObject({
      written: true,
      path: 'overview-2026-11-23_1530..2026-11-24_1530.html',
      window: { from: NOW - DAY, to: NOW },
      sessions: 1,
      truncated: false,
    })
    expect(result.notes).toBeUndefined()
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('Shipped the thing')
    expect(html).toContain('A quiet day.')
    expect(html).toContain(
      '<p class="title"><span class="icon" aria-hidden="true">💬</span>Shipped the thing</p>',
    )
    expect(html).not.toMatch(/<script/i)
    expect(html.match(/<h1>/g)).toHaveLength(1)
    expect(html).not.toContain('<ol')
  })

  it('accepts the window a model sends: a kind tag in range beside lastHours', async () => {
    const id = await titled(await seedSession([historyEntry({ timestamp: NOW - HOUR })]), 'Tagged')

    const result = await writeJson(await writeTool(hostFor()), {
      range: 'lastHours',
      lastHours: 1,
      summaries: { [id]: 'A quiet hour.' },
    })

    expect(result).toMatchObject({ written: true, window: { from: NOW - HOUR, to: NOW } })
  })

  it('escapes the Title and the summary it writes', async () => {
    const id = await titled(await seedSession([historyEntry({})]), '<b>Bold</b> & "quoted"')
    const host = hostFor()

    const result = await write(host, 'last-24h', {
      [id]: 'It shipped </p><script>alert(1)</script> the thing.',
    })
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')

    expect(html).toContain('&lt;b&gt;Bold&lt;/b&gt; &amp; &quot;quoted&quot;')
    expect(html).toContain('It shipped &lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt; the thing.')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toContain('<b>Bold</b>')
  })

  it('returns the live preview URL only when it serves this Workspace', async () => {
    const id = await seedSession([historyEntry({})])
    const host = hostFor()
    const summaries = { [id]: 'A day.' }

    preview.root = path.join(dirs.real, 'somewhere-else')
    preview.base = 'http://127.0.0.1:4711/'
    const elsewhere = await write(host, 'last-24h', summaries)
    expect(elsewhere.written).toBe(true)
    expect(elsewhere.path).toBe('overview-2026-11-23_1530..2026-11-24_1530.html')
    expect(elsewhere.url).toBeUndefined()

    preview.root = host.workspaceDir
    preview.base = 'http://127.0.0.1:4711/'
    const served = await write(host, 'last-24h', summaries)
    expect(served.url).toBe('http://127.0.0.1:4711/overview-2026-11-23_1530..2026-11-24_1530.html')
  })

  it('replaces the same range and leaves a different range alone', async () => {
    const id = await seedSession([
      historyEntry({ timestamp: new Date(2026, 10, 23, 10).getTime() }),
      historyEntry({ timestamp: new Date(2026, 10, 24, 10).getTime() }),
    ])
    const host = hostFor()
    const yesterday = { from: '2026-11-23T00:00:00', to: '2026-11-24T00:00:00' }
    const today = { from: '2026-11-24T00:00:00', to: '2026-11-25T00:00:00' }

    const first = await write(host, yesterday, { [id]: 'First summary.' })
    const firstPath = path.join(host.workspaceDir, String(first.path))
    expect(await fs.readFile(firstPath, 'utf8')).toContain('First summary.')

    const rewritten = await write(host, yesterday, { [id]: 'Rewritten summary.' })
    expect(rewritten.path).toBe(first.path)
    const rewrittenHtml = await fs.readFile(firstPath, 'utf8')
    expect(rewrittenHtml).toContain('Rewritten summary.')
    expect(rewrittenHtml).not.toContain('First summary.')
    expect(await htmlFiles()).toHaveLength(1)

    const other = await write(host, today, { [id]: 'Another summary.' })
    expect(other.path).not.toBe(first.path)
    expect(await htmlFiles()).toHaveLength(2)
    expect(await fs.readFile(firstPath, 'utf8')).toBe(rewrittenHtml)
  })

  it('refuses "nothing is included", writes no file, and names the reason', async () => {
    await seedSession([historyEntry({})], { included: false })
    const host = hostFor()

    const result = await write(host, 'last-24h', {})

    expect(result).toMatchObject({ written: false, outcome: 'none-included' })
    expect(String(result.message)).toMatch(/included in Overviews/i)
    expect(await htmlFiles()).toEqual([])
  })

  it('refuses "included but quiet", writes no file, and names the other reason', async () => {
    await seedSession([historyEntry({ timestamp: NOW - 10 * DAY })])
    const host = hostFor()

    const result = await write(host, 'last-24h', {})

    expect(result).toMatchObject({ written: false, outcome: 'none-in-range' })
    expect(String(result.message)).toMatch(/no turn/i)
    expect(await htmlFiles()).toEqual([])
  })

  it('reports truncation in the result and the page footnote', async () => {
    const entries = Array.from({ length: 45 }, (_, index) =>
      historyEntry({
        timestamp: NOW - (45 - index) * 60_000,
      }),
    )
    const id = await seedSession(entries)
    const host = hostFor()

    const result = await write(host, 'last-24h', { [id]: 'A busy day.' })

    expect(result).toMatchObject({
      written: true,
      truncated: true,
      shownEntries: 40,
      totalEntries: 45,
    })
    expect(result.openingTruncated).toBeUndefined()
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('OVERVIEW_REPORT_TRUNCATED')
    expect(html.match(/class="note"/g)).toHaveLength(1)
  })

  it('reports the Sessions the line budget left out, and the page says so', async () => {
    for (let index = 0; index < 11; index++) {
      await seedSession(
        Array.from({ length: 40 }, (_, line) =>
          historyEntry({
            timestamp: NOW - (index + 1) * HOUR - line * 60_000,
          }),
        ),
        { updatedAt: NOW - index * HOUR },
      )
    }
    const host = hostFor()
    const summaries = await summariesFor(host, 'last-24h')

    const result = await write(host, 'last-24h', summaries)

    expect(result).toMatchObject({
      written: true,
      sessions: 10,
      sessionsOmitted: 1,
      shownEntries: 400,
      totalEntries: 440,
      truncated: true,
    })
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('OVERVIEW_REPORT_TRUNCATED')
    expect(html.match(/<article class="card">/g)).toHaveLength(10)
  })

  it('renders the chrome strings the renderer shipped, with their locale', async () => {
    const id = await seedSession([historyEntry({})])
    const host = hostFor({
      responseLocale: 'de',
      overviewChrome: {
        locale: 'de',
        strings: {
          ...CHROME.strings,
          OVERVIEW_PAGE_TITLE: 'Überblick: {from} bis {to}',
          OVERVIEW_REPORT_TRUNCATED: 'Neueste {shown} von {total}',
        },
      },
    })

    const result = await write(host, 'last-24h', { [id]: 'Ein Tag.' })
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('<html lang="de">')
    expect(html).toContain('<title>Überblick: 2026-11-23 15:30 bis 2026-11-24 15:30</title>')
  })

  it('refuses when the chrome did not reach the turn instead of rendering a raw key', async () => {
    await seedSession([historyEntry({})])
    const host = fixtureHostFor({
      workspaceDir: path.join(dirs.real, 'workspace'),
      agentDir: dirs.real,
    })

    const text = await writeText(host, 'last-24h', {})

    expect(text).toMatch(/Overview language/i)
    expect(text).not.toContain('OVERVIEW_PAGE_TITLE')
    expect(await htmlFiles()).toEqual([])
  })

  it('refuses when the turn has no Session to exclude, and writes no file', async () => {
    await seedSession([historyEntry({})])

    const text = await writeText(hostFor({ sessionRef: null }), 'last-24h', {})

    expect(text).toMatch(/not attached to a Session/i)
    expect(await htmlFiles()).toEqual([])
  })

  it('requires a summary for every Session the Overview shows, naming handle and Title', async () => {
    const first = await titled(await seedSession([historyEntry({})]), 'First Session')
    const second = await titled(await seedSession([historyEntry({})]), 'Second Session')
    const host = hostFor()

    const text = await writeText(host, 'last-24h', { [first]: 'Only the first.' })

    expect(text).toMatch(/summary/i)
    expect(text).toContain('Second Session')
    expect(text).toContain(handleOf(second))
    expect(text).not.toContain('First Session')
    expect(await htmlFiles()).toEqual([])
  })

  it('still refuses when a Session is left with only a blank summary', async () => {
    const first = await titled(await seedSession([historyEntry({})]), 'First Session')
    await titled(await seedSession([historyEntry({})]), 'Second Session')
    const host = hostFor()

    const text = await writeText(host, 'last-24h', { [first]: '   ' })

    expect(text).toMatch(/summary/i)
    expect(text).toContain('First Session')
    expect(text).toContain(handleOf(first))
    expect(await htmlFiles()).toEqual([])
  })

  it('shortens a summary over 600 characters instead of refusing it', async () => {
    const id = await titled(await seedSession([historyEntry({})]), 'Long Session')
    const host = hostFor()

    const result = await write(host, 'last-24h', { [id]: 'x'.repeat(601) })

    expect(result.written).toBe(true)
    expect(result.notes).toEqual([expect.stringContaining('600')])
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain(`${'x'.repeat(599)}…`)
    expect(html).not.toContain('x'.repeat(600))
  })

  it('accepts a summary of exactly 600 characters without a note', async () => {
    const id = await titled(await seedSession([historyEntry({})]), 'Exact Session')
    const host = hostFor()

    const result = await write(host, 'last-24h', { [id]: 'x'.repeat(600) })

    expect(result.written).toBe(true)
    expect(result.notes).toBeUndefined()
  })

  it('keys summaries by handle, full id or exact Title', async () => {
    const byHandle = await titled(await seedSession([historyEntry({})]), 'Handle Session')
    const byTitle = await titled(await seedSession([historyEntry({})]), 'Titled Session')
    const host = hostFor()
    const data = JSON.parse(
      textOf(await (await dataTool(host)).execute('call-1', { range: 'last-24h' })),
    ) as { sessions: { id: string; handle: string }[] }
    const handle = data.sessions.find((session) => session.id === byHandle)!.handle

    const result = await writeJson(await writeTool(host), {
      range: 'last-24h',
      summaries: {
        [handle]: 'Summarised by handle.',
        'titled session': 'Summarised by title.',
      },
    })

    expect(result.written).toBe(true)
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('Summarised by handle.')
    expect(html).toContain('Summarised by title.')
    expect(byTitle).toBeTruthy()
  })

  it('ignores a summary key that matches no shown Session, with a note', async () => {
    const shown = await titled(await seedSession([historyEntry({})]), 'Shown Session')
    const host = hostFor()

    const result = await writeJson(await writeTool(host), {
      range: 'last-24h',
      summaries: { [shown]: 'A real summary.', 'session-not-here': 'A summary for nobody.' },
    })

    expect(result.written).toBe(true)
    expect(result.notes).toEqual([expect.stringContaining('session-not-here')])
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('A real summary.')
    expect(html).not.toContain('A summary for nobody.')
  })

  it('ignores a non-string summary when the same Session has a usable one', async () => {
    const id = await titled(await seedSession([historyEntry({})]), 'Blanked Session')
    const host = hostFor()

    const result = await writeJson(await writeTool(host), {
      range: 'last-24h',
      summaries: { [id]: 42, [handleOf(id)]: 'Actually written.' },
    })

    expect(result.written).toBe(true)
    expect(result.notes).toEqual([expect.stringContaining('blank summary')])
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain('Actually written.')
  })

  it('uses the range overview_data resolved when the write names no window', async () => {
    const id = await titled(
      await seedSession([historyEntry({ timestamp: NOW - HOUR })]),
      'Remembered',
    )
    const host = hostFor()
    const data = JSON.parse(
      textOf(await (await dataTool(host)).execute('call-1', { range: 'last-24h' })),
    ) as { sessions: { id: string; handle: string }[] }
    const handle = data.sessions.find((session) => session.id === id)!.handle

    const result = await writeJson(await writeTool(host), {
      summaries: { [handle]: 'A remembered day.' },
    })

    expect(result).toMatchObject({ written: true, window: { from: NOW - DAY, to: NOW } })
  })

  it('still answers an invalid window with the range message after a data call', async () => {
    const id = await titled(await seedSession([historyEntry({})]), 'Invalid Range')
    const host = hostFor()
    await (await dataTool(host)).execute('call-1', { range: 'last-24h' })

    const text = await writeText(host, 'since forever', { [handleOf(id)]: 'A summary.' })

    expect(text).toMatch(/range|date|hour/i)
    expect(await htmlFiles()).toEqual([])
  })

  it("ignores a picture that is another Session's candidate, with a note", async () => {
    const first = await seedPictureSession('first-picture')
    const second = await seedPictureSession('second-picture')
    const host = hostFor()

    const result = await writeJson(await writeTool(host), {
      range: 'last-24h',
      summaries: { [first.id]: 'First.', [second.id]: 'Second.' },
      covers: { [first.id]: second.path },
    })

    expect(result.written).toBe(true)
    expect(result.notes).toEqual([expect.stringContaining('Ignored the picture')])
    const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
    expect(html).toContain(pictureUri('first-picture'))
  })

  it('ignores a picture from outside the range, with a note', async () => {
    const { id } = await createSession()
    const outsidePath = path.join(sessionPaths(id).filesDir, 'last-month.png')
    await fs.mkdir(path.dirname(outsidePath), { recursive: true })
    await fs.writeFile(outsidePath, 'old')
    await writeHistoryLines(id, [
      JSON.stringify(
        historyEntry({
          kind: 'image',
          preset: 'Image Gen',
          timestamp: NOW - 10 * DAY,
          artifacts: [{ path: 'files/last-month.png', mediaType: 'image' }],
        }),
      ),
      JSON.stringify(historyEntry({ timestamp: NOW - HOUR })),
    ])
    await mutateSession(id, (file) => ({ ...file, updatedAt: NOW }))
    await setSessionIncludedInOverviews(id, true)
    const host = hostFor()

    const result = await writeJson(await writeTool(host), {
      range: 'last-24h',
      summaries: { [id]: 'A summary.' },
      covers: { [id]: outsidePath },
    })

    expect(result.written).toBe(true)
    expect(result.notes).toEqual([expect.stringContaining('Ignored the picture')])
    expect(await htmlFiles()).toHaveLength(1)
  })

  it('ignores a picture for a Session the Overview does not show, with a note', async () => {
    await seedPictureSession('shown')
    const quiet = await seedSession([historyEntry({ timestamp: NOW - 10 * DAY })])
    const host = hostFor()
    const summaries = await summariesFor(host, 'last-24h')

    const result = await writeJson(await writeTool(host), {
      range: 'last-24h',
      summaries,
      covers: { [quiet]: path.join(dirs.real, 'anything.png') },
    })

    expect(result.written).toBe(true)
    expect(result.notes).toEqual([expect.stringContaining('no Session')])
    expect(await htmlFiles()).toHaveLength(1)
  })
})
