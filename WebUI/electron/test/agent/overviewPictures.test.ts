import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OverviewChrome } from '@/types/overviewChrome'
import type { OverviewSummaryPicture } from '@/types/sessionIpc'

// The pictures an Overview embeds are the tool's job: the stored Overview
// Summary's picture is downscaled with Electron's decoder and inlined as a data
// URI, within a page-wide budget. Electron's decoder does not exist under vitest,
// so `nativeImage` is a stand-in that reports the size asked for and records every
// resize it was asked to make.

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
const { mutateSession, resetSessionsForTest, sessionPaths, setSessionDeps } =
  await import('../../session/sessions')
const { ensureWorkspaceEntry } = await import('../../session/appWorkspace')
const { NOW, HOUR, historyEntry, seedSession, hostFor, textOf, toolNamed, writeFile } =
  await import('../overviewFixtures')

const CHROME: OverviewChrome = {
  locale: 'en-US',
  strings: {
    OVERVIEW_PAGE_TITLE: 'Sessions active {from} to {to}',
    OVERVIEW_OMITTED_NOTE: 'Omitted: {sessions}',
    OVERVIEW_BEHIND_NOTE: 'Behind: {sessions}',
  },
}

async function write(params: Record<string, unknown> = { range: 'last-24h' }) {
  const host = hostFor({
    workspaceDir: path.join(dirs.real, 'workspace'),
    overviewChrome: CHROME,
    responseLocale: 'en-US',
  })
  const tool = toolNamed(await overviewCapability.buildTools!(host), 'overview') as unknown as {
    execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
  }
  const result = JSON.parse(textOf(await tool.execute('call-1', params))) as Record<string, unknown>
  return {
    result,
    html: await fs.readFile(path.join(dirs.real, 'workspace', String(result.path)), 'utf8'),
  }
}

function imageSources(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((match) => match[1])
}

function dataUriOf(key: string, extraBytes = 8): string {
  return `data:image/png;base64,${Buffer.from(key).toString('base64')}${'A'.repeat(extraBytes)}`
}

async function writeArtifact(sessionId: string, name: string, bytes = name): Promise<string> {
  await writeFile(path.join(sessionPaths(sessionId).filesDir, name), bytes)
  return `files/${name}`
}

async function seedPictured(
  key: string,
  picture: (relativePath: string) => OverviewSummaryPicture,
  options: { timestamp?: number; kind?: 'image' | 'video' | 'agent' } = {},
): Promise<string> {
  const timestamp = options.timestamp ?? NOW - HOUR
  const id = await seedSession([historyEntry({ kind: options.kind ?? 'image', timestamp })], {
    summary: `Summary for ${key}.`,
  })
  const relativePath = await writeArtifact(id, `${key}.png`, key)
  await setPicture(id, picture(relativePath))
  return id
}

async function setPicture(id: string, picture: OverviewSummaryPicture): Promise<void> {
  await mutateSession(id, (file) => ({
    ...file,
    overviewSummary: {
      state: 'ready' as const,
      contractVersion: 1,
      text: file.overviewSummary?.text ?? 'A summary.',
      writtenAt: NOW,
      ...(file.overviewSummary?.coveredEntryId
        ? { coveredEntryId: file.overviewSummary.coveredEntryId }
        : {}),
      picture,
    },
  }))
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
  it('inlines the stored picture as a data URI downscaled to a 480px edge', async () => {
    await seedPictured('big-image', (relativePath) => ({
      path: relativePath,
      mediaType: 'image',
      source: 'artifact',
    }))

    const { html } = await write()

    expect(imageSources(html)).toEqual([dataUriOf('big-image')])
    expect(image.resizeCalls).toContainEqual({ key: 'big-image', width: 480 })
  })

  it('downscales a tall picture by its height', async () => {
    image.sizes.set('tall-image', { width: 600, height: 1200 })
    await seedPictured('tall-image', (relativePath) => ({
      path: relativePath,
      mediaType: 'image',
      source: 'artifact',
    }))

    await write()

    expect(image.resizeCalls).toContainEqual({ key: 'tall-image', height: 480 })
  })

  it('leaves a picture already inside 480px alone', async () => {
    image.sizes.set('small-image', { width: 320, height: 240 })
    await seedPictured('small-image', (relativePath) => ({
      path: relativePath,
      mediaType: 'image',
      source: 'artifact',
    }))

    const { html } = await write()

    expect(imageSources(html)).toEqual([dataUriOf('small-image')])
    expect(image.resizeCalls.some((call) => call.key === 'small-image')).toBe(false)
  })

  it('references no external or app-specific URL scheme', async () => {
    await seedPictured('artifact-image', (relativePath) => ({
      path: relativePath,
      mediaType: 'image',
      source: 'artifact',
    }))

    const { html } = await write()

    expect(imageSources(html).length).toBeGreaterThan(0)
    for (const source of imageSources(html)) expect(source.startsWith('data:image/')).toBe(true)
    expect(html).not.toContain('aipg-media://')
    expect(html).not.toContain('file://')
    expect(html).not.toMatch(/<img\b[^>]*\bsrc="(?:https?:)?\/\//)
  })

  it('omits pictures past the total page budget instead of growing without bound', async () => {
    image.extraBytes.set('budget-1', 3_000_000)
    image.extraBytes.set('budget-2', 3_000_000)
    image.extraBytes.set('budget-3', 3_000_000)
    await seedPictured(
      'budget-3',
      (relativePath) => ({ path: relativePath, mediaType: 'image', source: 'artifact' }),
      { timestamp: NOW - HOUR },
    )
    await seedPictured(
      'budget-2',
      (relativePath) => ({ path: relativePath, mediaType: 'image', source: 'artifact' }),
      { timestamp: NOW - 2 * HOUR },
    )
    await seedPictured(
      'budget-1',
      (relativePath) => ({ path: relativePath, mediaType: 'image', source: 'artifact' }),
      { timestamp: NOW - 3 * HOUR },
    )

    const { html } = await write()

    expect(imageSources(html)).toEqual([dataUriOf('budget-3', 3_000_000)])
    // Once the budget has bound nothing later is decoded.
    const decoded = image.resizeCalls
      .filter((call) => call.key.startsWith('budget-'))
      .map((call) => call.key)
    expect(decoded).toContain('budget-3')
    expect(decoded).toContain('budget-2')
    expect(decoded).not.toContain('budget-1')
  })

  it('renders a Session with no picture with its Title, summary and type icon', async () => {
    await seedSession([historyEntry({ kind: 'chat' })], { summary: 'A plain account.' })

    const { html } = await write()

    expect(html).toContain('<p class="summary">A plain account.</p>')
    expect(html).toContain('<span class="icon" aria-hidden="true">💬</span>')
    expect(html).not.toMatch(/<img\b/)
  })

  it('gives audio-only and 3D-only Sessions no picture, only their type icon', async () => {
    await seedSession(
      [
        historyEntry({
          kind: 'tts',
          prompt: 'spoken',
          artifacts: [{ path: 'files/speech.wav', mediaType: 'audio' }],
        }),
      ],
      { summary: 'Audio work.' },
    )
    await seedSession(
      [
        historyEntry({
          kind: 'edit',
          prompt: 'a model',
          artifacts: [{ path: 'files/model.glb', mediaType: 'model3d' }],
        }),
      ],
      { summary: 'A 3D model.' },
    )

    const { html } = await write()

    expect(html).toContain('<p class="summary">Audio work.</p>')
    expect(html).toContain('<p class="summary">A 3D model.</p>')
    expect(html).toContain('<span class="icon" aria-hidden="true">🔊</span>')
    expect(html).toContain('<span class="icon" aria-hidden="true">🧊</span>')
    expect(html).not.toMatch(/<img\b/)
  })

  it('shows nothing when the stored picture file is gone, never an older picture', async () => {
    const id = await seedSession(
      [
        historyEntry({
          kind: 'image',
          prompt: 'older image',
          artifacts: [{ path: 'files/older.png', mediaType: 'image' }],
        }),
      ],
      {
        summary: 'The newest picture is missing.',
        summaryPicture: { path: 'files/gone.png', mediaType: 'image', source: 'artifact' },
      },
    )
    await writeArtifact(id, 'older.png')

    const { html } = await write()

    expect(html).toContain('<p class="summary">The newest picture is missing.</p>')
    expect(html).not.toMatch(/<img\b/)
  })

  it("renders a video's stored poster", async () => {
    const id = await seedSession([historyEntry({ kind: 'video' })], {
      summary: 'A video.',
    })
    const workspace = await ensureWorkspaceEntry(id)
    await writeFile(path.join(workspace.hostPath, 'poster.png'), 'video-poster')
    await setPicture(id, {
      folderId: workspace.id,
      path: 'poster.png',
      mediaType: 'image',
      source: 'video-thumbnail',
    })

    const { html } = await write()

    expect(imageSources(html)).toEqual([dataUriOf('video-poster')])
  })

  it("renders a game's stored icon from its own folder", async () => {
    const iconPath = path.join(dirs.games, 'space-dodger', 'icon.png')
    await writeFile(iconPath, 'game-icon')
    await seedSession([historyEntry({ kind: 'agent', preset: 'Game Agent' })], {
      summary: 'A game.',
      summaryPicture: { path: iconPath, mediaType: 'image', source: 'game-icon' },
    })

    const { html } = await write()

    expect(imageSources(html)).toEqual([dataUriOf('game-icon')])
  })
})
