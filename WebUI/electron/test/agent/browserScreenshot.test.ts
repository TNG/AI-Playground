import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Web debugging `browser` tool's screenshot action, driven through the
// capability (not by stubbing the browser action), with only Electron's window
// and web contents faked.

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)

class FakeBrowserWindow {
  destroyed = false
  url = ''
  capturePageResult: { toPNG: () => Buffer } | Error = { toPNG: () => PNG }
  sendCommand = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'Page.captureScreenshot') {
      return { data: PNG.toString('base64') }
    }
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
const { closeAllBrowserSessions, savedScreenshotText } = await import('../../agent/agentBrowser.ts')

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

async function browserTool(workspaceDir: string, sessionId = 'shot-session'): Promise<Tool> {
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

describe('the Web debugging screenshot action', () => {
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE

  beforeEach(() => {
    instances.length = 0
  })

  afterEach(() => {
    closeAllBrowserSessions()
    vi.restoreAllMocks()
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('saves a screenshot of an opened external page at the workspace root', async () => {
    const workspace = tempDir('aipg-shot-root-')
    const tool = await browserTool(workspace)
    await openBrowser(tool)

    const result = await tool.execute('shot-1', { action: 'screenshot' })

    const files = pngFiles(workspace)
    expect(files).toHaveLength(1)
    expect(fs.statSync(path.join(workspace, files[0])).size).toBe(PNG.length)
    expect(text(result)).toBe(savedScreenshotText(files[0]))
    expect(result.details).toBeUndefined()
    expect(fs.existsSync(path.join(workspace, 'generated'))).toBe(false)
  })

  it('saves a screenshot of a workspace page served by the preview at the root', async () => {
    const workspace = tempDir('aipg-shot-preview-')
    const tool = await browserTool(workspace)
    await openBrowser(tool, 'http://127.0.0.1:41235/index.html')

    const result = await tool.execute('shot-preview', { action: 'screenshot' })

    const files = pngFiles(workspace)
    expect(files).toHaveLength(1)
    expect(fs.statSync(path.join(workspace, files[0])).size).toBeGreaterThan(0)
    expect(text(result)).toBe(savedScreenshotText(files[0]))
  })

  it('refuses a screenshot when no page is open, telling the model to open one', async () => {
    const workspace = tempDir('aipg-shot-none-')
    const tool = await browserTool(workspace)

    const result = await tool.execute('shot-none', { action: 'screenshot' })

    expect(text(result)).toContain('No page is open')
    expect(text(result)).toContain('"open"')
    expect(pngFiles(workspace)).toHaveLength(0)
    expect(fs.existsSync(path.join(workspace, 'generated'))).toBe(false)
  })

  it('refuses a screenshot of a failed page load instead of capturing the error page', async () => {
    const workspace = tempDir('aipg-shot-error-')
    const tool = await browserTool(workspace)
    await openBrowser(tool)
    instances[0].url = 'chrome-error://chromewebdata/'

    const result = await tool.execute('shot-error', { action: 'screenshot' })

    expect(text(result)).toContain('failed to load')
    expect(text(result)).toContain('"open"')
    expect(text(result)).not.toContain('No page is open')
    expect(pngFiles(workspace)).toHaveLength(0)
    expect(fs.existsSync(path.join(workspace, 'generated'))).toBe(false)
  })

  it('falls back to the page capture when the debugger capture throws', async () => {
    const workspace = tempDir('aipg-shot-fallback-')
    const tool = await browserTool(workspace)
    await openBrowser(tool)
    instances[0].sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') throw new Error('debugger detached')
      return {}
    })

    const result = await tool.execute('shot-fallback', { action: 'screenshot' })

    expect(instances[0].sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
    })
    expect(instances[0].webContents.capturePage).toHaveBeenCalled()
    expect(pngFiles(workspace)).toHaveLength(1)
    expect(text(result)).toMatch(/^Saved screenshot to /)
  })

  it('writes no file and reports a failure when the capture is empty', async () => {
    const workspace = tempDir('aipg-shot-empty-')
    const tool = await browserTool(workspace)
    await openBrowser(tool)
    instances[0].sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') return { data: '' }
      return {}
    })
    instances[0].capturePageResult = { toPNG: () => Buffer.alloc(0) }

    const result = await tool.execute('shot-empty', { action: 'screenshot' })

    expect(text(result)).toContain('came back empty')
    expect(pngFiles(workspace)).toHaveLength(0)
    expect(fs.existsSync(path.join(workspace, 'generated'))).toBe(false)
  })

  it('writes no file and reports a failure when both capture paths throw', async () => {
    const workspace = tempDir('aipg-shot-broken-')
    const tool = await browserTool(workspace)
    await openBrowser(tool)
    instances[0].sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') throw new Error('debugger gone')
      return {}
    })
    instances[0].capturePageResult = new Error('no frame')

    const result = await tool.execute('shot-broken', { action: 'screenshot' })

    expect(text(result)).toContain('came back empty')
    expect(pngFiles(workspace)).toHaveLength(0)
  })

  it('keeps a game workspace screenshot in generated/ with the same text and thumbnail', async () => {
    const home = tempDir('aipg-shot-home-')
    delete process.env.USERPROFILE
    process.env.HOME = home
    const workspace = path.join(home, 'AI-Playground', 'games', 'Star Blaster')
    fs.mkdirSync(workspace, { recursive: true })

    const send = vi.fn()
    const { setKernelEventWindow } = await import('../../kernel/kernelBus.ts')
    setKernelEventWindow({ isDestroyed: () => false, webContents: { send } } as never)
    const { agentTurns } = await import('../../agent/piAgentState.ts')
    agentTurns.set('game-session', {
      sessionId: 'game-session',
      turnId: 'turn-1',
      abort: new AbortController(),
      live: null,
    })

    const tool = await browserTool(workspace, 'game-session')
    await openBrowser(tool)
    const result = await tool.execute('shot-game', { action: 'screenshot' })

    const saved = fs.readdirSync(path.join(workspace, 'generated'))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatch(/^screenshot-\d+\.png$/)
    expect(text(result)).toBe(savedScreenshotText(`generated/${saved[0]}`))
    expect(result.details).toBeUndefined()
    expect(pngFiles(workspace)).toHaveLength(0)
    expect(send).toHaveBeenCalledWith(
      'kernel:event',
      expect.objectContaining({
        type: 'agent-tool-image',
        sessionId: 'game-session',
        toolCallId: 'shot-game',
        dataUri: expect.stringMatching(/^data:image\/png;base64,/),
        label: `generated/${saved[0]}`,
      }),
    )
    agentTurns.delete('game-session')
  })

  it('names two captures in one turn apart so neither overwrites the other', async () => {
    const workspace = tempDir('aipg-shot-two-')
    const tool = await browserTool(workspace)
    await openBrowser(tool)
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)

    const first = await tool.execute('shot-a', { action: 'screenshot' })
    const second = await tool.execute('shot-b', { action: 'screenshot' })

    expect(pngFiles(workspace).sort()).toEqual([
      'screenshot-1700000000000-1.png',
      'screenshot-1700000000000.png',
    ])
    expect(text(first)).not.toBe(text(second))
    for (const file of pngFiles(workspace)) {
      expect(fs.statSync(path.join(workspace, file)).size).toBe(PNG.length)
    }
  })
})
