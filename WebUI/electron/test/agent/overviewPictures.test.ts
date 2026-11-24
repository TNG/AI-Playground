import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverviewChrome } from '@/types/overviewChrome'

// The pictures an Overview embeds are the tool's job, not the renderer's: each
// Session's newest usable candidate is downscaled with Electron's decoder and
// inlined as a data URI, within a page-wide budget. Electron's decoder does not
// exist under vitest, so `nativeImage` is a stand-in that reports the size asked
// for and records every resize it was asked to make.

const dirs = vi.hoisted(() => ({ real: '', demo: '', games: '', mediaRecords: '' }))
const image = vi.hoisted(() => ({
  sizes: new Map<string, { width: number; height: number }>(),
  undecodable: new Set<string>(),
  extraBytes: new Map<string, number>(),
  resizeCalls: [] as { key: string; width?: number; height?: number }[],
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => dirs.real, getAppPath: () => dirs.real },
  BrowserWindow: class {},
  net: {},
  nativeImage: {
    createFromBuffer: (buffer: Buffer) => {
      const key = buffer.toString('utf8')
      const size = image.sizes.get(key) ?? { width: 1024, height: 768 }
      const dataUri = `data:image/png;base64,${Buffer.from(key).toString('base64')}${'A'.repeat(
        image.extraBytes.get(key) ?? 8,
      )}`
      const make = () => ({
        isEmpty: () => image.undecodable.has(key),
        getSize: () => size,
        toDataURL: () => dataUri,
        resize: (options: { width?: number; height?: number }) => {
          image.resizeCalls.push({ key, ...options })
          return make()
        },
      })
      return make()
    },
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
  workspacePreviewRoot: () => null,
  resolvePreviewUrl: (url: string | undefined) => url,
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
const { ensureWorkspaceEntry } = await import('../../session/appWorkspace')
const { createGame, updateGame } = await import('../../agent/games/gameLibrary')
const { sessionFolderMediaUrl } = await import('@/lib/comfyWorkflow')
const { OVERVIEW_CHROME_KEYS } = await import('@/types/overviewChrome')
const {
  NOW,
  HOUR,
  historyEntry,
  seedSession,
  writeFile,
  hostFor: fixtureHostFor,
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

function hostFor(): Host {
  return fixtureHostFor({
    workspaceDir: path.join(dirs.real, 'workspace'),
    agentDir: dirs.real,
    overviewChrome: CHROME,
    responseLocale: 'en-US',
  })
}

async function write(
  covers?: Record<string, string>,
): Promise<{ result: Record<string, unknown>; html: string }> {
  const host = hostFor()
  const tool = toolNamed(await overviewCapability.buildTools!(host), 'overview_write')
  const result = await writeJson(tool, {
    range: 'last-24h',
    opening: 'A quiet day.',
    ...(covers ? { covers } : {}),
  })
  const html = await fs.readFile(path.join(host.workspaceDir, String(result.path)), 'utf8')
  return { result, html }
}

function imageSources(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((match) => match[1])
}

function dataUriOf(key: string, extraBytes = 8): string {
  return `data:image/png;base64,${Buffer.from(key).toString('base64')}${'A'.repeat(extraBytes)}`
}

async function seedImageSession(key: string, updatedAt = NOW): Promise<string> {
  const { id } = await createSession()
  await writeFile(path.join(sessionPaths(id).filesDir, `${key}.png`), key)
  await writeHistoryLines(id, [
    JSON.stringify(
      historyEntry({
        kind: 'image',
        preset: 'Image Gen',
        prompt: key,
        artifacts: [{ path: `files/${key}.png`, mediaType: 'image' }],
      }),
    ),
  ])
  await mutateSession(id, (file) => ({ ...file, updatedAt }))
  await setSessionIncludedInOverviews(id, true)
  return id
}

/** A Session with several picture candidates, newest first by timestamp. */
async function seedPictureSession(
  pictures: { key: string; time: number }[],
): Promise<{ id: string; paths: Record<string, string> }> {
  const { id } = await createSession()
  const paths: Record<string, string> = {}
  for (const picture of pictures) {
    const filePath = path.join(sessionPaths(id).filesDir, `${picture.key}.png`)
    await writeFile(filePath, picture.key)
    paths[picture.key] = filePath
  }
  await writeHistoryLines(
    id,
    pictures.map((picture) =>
      JSON.stringify(
        historyEntry({
          kind: 'image',
          preset: 'Image Gen',
          prompt: picture.key,
          timestamp: picture.time,
          artifacts: [{ path: `files/${picture.key}.png`, mediaType: 'image' }],
        }),
      ),
    ),
  )
  const updatedAt = Math.max(...pictures.map((picture) => picture.time))
  await mutateSession(id, (file) => ({ ...file, updatedAt }))
  await setSessionIncludedInOverviews(id, true)
  return { id, paths }
}

/** One `<section class="session">` block per reported Session, in report order. */
function sessionSections(html: string): string[] {
  return html.split('<section class="session">').slice(1)
}

async function seedVideoSession(): Promise<string> {
  const { id } = await createSession()
  const workspace = await ensureWorkspaceEntry(id)
  await writeFile(path.join(workspace.hostPath, 'clip.mp4'), 'video')
  await writeFile(path.join(workspace.hostPath, 'video-thumb.png'), 'video-thumb')
  const videoUrl = sessionFolderMediaUrl(id, workspace.id, 'clip.mp4')
  const thumbnailUrl = sessionFolderMediaUrl(id, workspace.id, 'video-thumb.png')
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
  return id
}

async function seedGameSession(): Promise<string> {
  const game = createGame({ name: 'Space Dodger' }, dirs.games)
  await writeFile(path.join(game.dir, 'icon.png'), 'game-icon')
  updateGame(game.dir, { icon: 'icon.png' })
  return seedSession(
    [historyEntry({ kind: 'agent', preset: 'Game Agent', prompt: 'make it harder' })],
    { harnessWorkspaces: { 'Game Agent': game.dir } },
  )
}

beforeAll(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aipg-overview-pictures-'))
  dirs.real = path.join(root, 'sessions')
  dirs.demo = path.join(root, 'sessions-demo')
  dirs.games = path.join(root, 'games')
  dirs.mediaRecords = path.join(root, 'media-records')
})

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  image.sizes.clear()
  image.undecodable.clear()
  image.extraBytes.clear()
  image.resizeCalls.length = 0
  setSessionDeps({ isDemoMode: () => false })
  await fs.mkdir(path.join(dirs.real, 'workspace'), { recursive: true })
})

afterEach(async () => {
  vi.useRealTimers()
  resetSessionsForTest()
  await fs.rm(dirs.real, { recursive: true, force: true })
  await fs.rm(dirs.games, { recursive: true, force: true })
  await fs.rm(`${dirs.real}-workspaces`, { recursive: true, force: true })
})

describe('Overview pictures', () => {
  it('inlines an image Artifact as a downscaled data URI', async () => {
    await seedImageSession('big-image')

    const { result, html } = await write()

    expect(result.written).toBe(true)
    expect(result.pictures).toBe(1)
    expect(result.picturesOmitted).toBe(0)
    expect(imageSources(html)).toEqual([`${dataUriOf('big-image')}`])
    expect(imageSources(html)[0]).toMatch(/^data:image\//)
    expect(image.resizeCalls).toContainEqual({ key: 'big-image', width: 480 })
  })

  it('downscales a tall picture by its height', async () => {
    image.sizes.set('tall-image', { width: 600, height: 1200 })
    await seedImageSession('tall-image')

    await write()

    expect(image.resizeCalls).toContainEqual({ key: 'tall-image', height: 480 })
  })

  it('leaves a picture already inside 480px alone', async () => {
    image.sizes.set('small-image', { width: 320, height: 240 })
    await seedImageSession('small-image')

    const { html } = await write()

    expect(imageSources(html)).toEqual([dataUriOf('small-image')])
    expect(image.resizeCalls.some((call) => call.key === 'small-image')).toBe(false)
  })

  it("uses a video's adopted timeline thumbnail", async () => {
    await seedVideoSession()

    const { html } = await write()

    expect(imageSources(html)).toEqual([dataUriOf('video-thumb')])
  })

  it("uses a game's icon from its library card", async () => {
    await seedGameSession()

    const { html } = await write()

    expect(imageSources(html)).toEqual([dataUriOf('game-icon')])
  })

  it('contains no external image scheme anywhere in the page', async () => {
    await seedImageSession('artifact-image', NOW)
    await seedVideoSession()
    await seedGameSession()

    const { html } = await write()

    expect(imageSources(html).length).toBeGreaterThan(0)
    for (const source of imageSources(html)) expect(source.startsWith('data:image/')).toBe(true)
    expect(html).not.toContain('aipg-media://')
    expect(html).not.toContain('file://')
    expect(html).not.toMatch(/<img\b[^>]*\bsrc="(?:https?:)?\/\//)
  })

  it('omits later pictures when the total picture budget binds, and reports them', async () => {
    image.extraBytes.set('budget-1', 3_000_000)
    image.extraBytes.set('budget-2', 3_000_000)
    image.extraBytes.set('budget-3', 3_000_000)
    await seedImageSession('budget-3', NOW)
    await seedImageSession('budget-2', NOW - HOUR)
    await seedImageSession('budget-1', NOW - 2 * HOUR)

    const { result, html } = await write()

    expect(result.written).toBe(true)
    expect(result.pictures).toBe(1)
    expect(result.picturesOmitted).toBe(2)
    expect(imageSources(html)).toEqual([dataUriOf('budget-3', 3_000_000)])
    // Once the budget has bound nothing later is decoded.
    const decoded = image.resizeCalls
      .filter((call) => call.key.startsWith('budget-'))
      .map((call) => call.key)
    expect(decoded).toContain('budget-3')
    expect(decoded).toContain('budget-2')
    expect(decoded).not.toContain('budget-1')
  })

  it('uses the picture the agent picked for a Session', async () => {
    const session = await seedPictureSession([
      { key: 'newest', time: NOW - HOUR },
      { key: 'chosen', time: NOW - 5 * HOUR },
    ])

    const { result, html } = await write({ [session.id]: session.paths.chosen })

    expect(result).toMatchObject({ written: true, pictures: 1, picturesOmitted: 0 })
    expect(imageSources(html)).toEqual([dataUriOf('chosen')])
    expect(image.resizeCalls.map((call) => call.key)).toContain('chosen')
    expect(image.resizeCalls.map((call) => call.key)).not.toContain('newest')
  })

  it('falls back to the newest picture when the agent leaves a Session out', async () => {
    await seedPictureSession([
      { key: 'newest', time: NOW - HOUR },
      { key: 'older', time: NOW - 5 * HOUR },
    ])

    const { html } = await write()

    expect(imageSources(html)).toEqual([dataUriOf('newest')])
    expect(image.resizeCalls.map((call) => call.key)).not.toContain('older')
  })

  it('applies the page budget to the chosen pictures', async () => {
    image.extraBytes.set('big-a', 3_000_000)
    image.extraBytes.set('big-b', 3_000_000)
    image.extraBytes.set('big-c', 3_000_000)
    const first = await seedPictureSession([
      { key: 'newest-a', time: NOW - HOUR },
      { key: 'big-a', time: NOW - 2 * HOUR },
    ])
    const second = await seedPictureSession([
      { key: 'newest-b', time: NOW - 2 * HOUR },
      { key: 'big-b', time: NOW - 3 * HOUR },
    ])
    const third = await seedPictureSession([
      { key: 'newest-c', time: NOW - 3 * HOUR },
      { key: 'big-c', time: NOW - 4 * HOUR },
    ])

    const { result, html } = await write({
      [first.id]: first.paths['big-a'],
      [second.id]: second.paths['big-b'],
      [third.id]: third.paths['big-c'],
    })

    expect(result).toMatchObject({ written: true, pictures: 1, picturesOmitted: 2 })
    expect(imageSources(html)).toEqual([dataUriOf('big-a', 3_000_000)])
  })

  it('leaves a Session with no picture alone, and a decode failure is only that', async () => {
    image.undecodable.add('broken-image')
    const audio = await seedSession([
      historyEntry({
        kind: 'tts',
        preset: 'Text to Speech',
        prompt: 'spoken',
        artifacts: [{ path: 'files/speech.wav', mediaType: 'audio' }],
      }),
    ])
    const threeD = await seedSession([
      historyEntry({
        kind: 'edit',
        preset: 'Image To 3D Model',
        prompt: 'model',
        artifacts: [{ path: 'files/model.glb', mediaType: 'model3d' }],
      }),
    ])
    const empty = await seedSession([historyEntry({ prompt: 'no output at all' })])
    await seedImageSession('broken-image', NOW - HOUR)
    await seedImageSession('good-image', NOW - 2 * HOUR)

    const { result, html } = await write()

    expect(result.written).toBe(true)
    expect(result.pictures).toBe(1)
    expect(imageSources(html)).toEqual([dataUriOf('good-image')])
    expect(audio).toBeTruthy()
    expect(threeD).toBeTruthy()
    expect(empty).toBeTruthy()
    for (const prompt of ['spoken', 'model', 'no output at all']) {
      const section = sessionSections(html).find((candidate) => candidate.includes(prompt))
      expect(section).toBeDefined()
      expect(section).not.toContain('<img')
      expect(section).toContain('<h3>')
      expect(section).toContain('<ol>')
    }
  })
})
