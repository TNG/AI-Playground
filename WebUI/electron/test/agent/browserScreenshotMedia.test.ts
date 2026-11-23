import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A screenshot taken by the Web debugging tool is turn media for a Session
// workspace, so a Reachable Session's Channels can carry it. A game workspace's
// screenshot never is.

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)

class FakeBrowserWindow {
  destroyed = false
  url = ''
  capturePageResult: { toPNG: () => Buffer } | Error = { toPNG: () => PNG }
  sendCommand = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'Page.captureScreenshot') return { data: PNG.toString('base64') }
    return {}
  })
  webContents = {
    setAudioMuted: vi.fn(),
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn(),
      sendCommand: (...args: [string, unknown?]) => this.sendCommand(...args),
    },
    on: vi.fn(),
    off: vi.fn(),
    getTitle: () => 'Example',
    getURL: () => this.url,
    loadURL: vi.fn(async (url: string) => {
      this.url = url
    }),
    capturePage: vi.fn(async () => {
      if (this.capturePageResult instanceof Error) throw this.capturePageResult
      return this.capturePageResult
    }),
    executeJavaScript: vi.fn(async () => ''),
  }
  isDestroyed = () => this.destroyed
  loadURL = vi.fn(async (url: string) => {
    this.url = url
  })
  destroy = vi.fn(() => {
    this.destroyed = true
  })

  constructor() {
    instances.push(this)
  }
}

const instances: FakeBrowserWindow[] = []

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
  BrowserWindow: FakeBrowserWindow,
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('../../agent/piRuntime.ts', () => ({
  loadPi: async () => ({ defineTool: (definition: unknown) => definition }),
}))

const { webDebugCapability } = await import('../../agent/capabilities/webDebug.ts')
const { closeAllBrowserSessions } = await import('../../agent/agentBrowser.ts')
const { onGeneratedMedia } = await import('../../agent/generatedMedia.ts')

type Tool = {
  name: string
  execute: (
    id: string,
    params: unknown,
  ) => Promise<{ content: { type: 'text'; text: string }[]; details?: unknown }>
}

const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function browserTool(workspaceDir: string, sessionId = 'shot-media-session'): Promise<Tool> {
  const built = (await webDebugCapability.buildTools?.({
    sessionId,
    workspaceDir,
    toolSpecs: [],
  } as never)) as unknown as Tool[]
  return built.find((tool) => tool.name === 'browser') as Tool
}

const text = (result: { content: { text: string }[] }) => result.content[0].text

function pngFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => entry.name)
}

const openBrowser = async (tool: Tool, url = 'https://example.com/page') => {
  await tool.execute('open-1', { action: 'open', url })
}

describe('the Web debugging screenshot as generated media', () => {
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  let stopListening: (() => void) | undefined

  beforeEach(() => {
    instances.length = 0
  })

  afterEach(() => {
    stopListening?.()
    stopListening = undefined
    closeAllBrowserSessions()
    vi.restoreAllMocks()
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  function collectNotes() {
    const notes: { workspaceDir: string; relativePaths: string[] }[] = []
    stopListening = onGeneratedMedia((workspaceDir, relativePaths) => {
      notes.push({ workspaceDir, relativePaths: [...relativePaths] })
    })
    return notes
  }

  it('notes a non-game screenshot as generated media at its saved path', async () => {
    const workspace = tempDir('aipg-shot-media-')
    const notes = collectNotes()
    const tool = await browserTool(workspace)
    await openBrowser(tool)

    const result = await tool.execute('shot-note', { action: 'screenshot' })

    const saved = pngFiles(workspace)
    expect(saved).toHaveLength(1)
    expect(text(result)).toBe(`Saved screenshot to ${saved[0]}`)
    expect(notes).toEqual([{ workspaceDir: workspace, relativePaths: [saved[0]] }])
  })

  it('never notes a screenshot in a game workspace', async () => {
    const home = tempDir('aipg-shot-media-home-')
    delete process.env.USERPROFILE
    process.env.HOME = home
    const workspace = path.join(home, 'AI-Playground', 'games', 'Star Blaster')
    fs.mkdirSync(workspace, { recursive: true })
    const notes = collectNotes()
    const tool = await browserTool(workspace)
    await openBrowser(tool)

    const result = await tool.execute('shot-media-game', { action: 'screenshot' })

    expect(fs.readdirSync(path.join(workspace, 'generated'))).toHaveLength(1)
    expect(text(result)).toMatch(/^Saved screenshot to generated\//)
    expect(notes).toEqual([])
  })

  it('notes nothing when no page is open', async () => {
    const workspace = tempDir('aipg-shot-media-none-')
    const notes = collectNotes()
    const tool = await browserTool(workspace)

    const result = await tool.execute('shot-media-none', { action: 'screenshot' })

    expect(text(result)).toContain('No page is open')
    expect(notes).toEqual([])
  })

  it('notes nothing when the capture is empty', async () => {
    const workspace = tempDir('aipg-shot-media-empty-')
    const notes = collectNotes()
    const tool = await browserTool(workspace)
    await openBrowser(tool)
    instances[0].sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') return { data: '' }
      return {}
    })
    instances[0].capturePageResult = { toPNG: () => Buffer.alloc(0) }

    const result = await tool.execute('shot-media-empty', { action: 'screenshot' })

    expect(text(result)).toContain('came back empty')
    expect(pngFiles(workspace)).toHaveLength(0)
    expect(notes).toEqual([])
  })
})
