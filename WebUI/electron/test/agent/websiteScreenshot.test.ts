import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Website screenshots `webScreenshot` tool, driven through the capability
// against the real capture engine, with only Electron's window and web contents
// faked.

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)

type CommandMock = {
  mock: { calls: [string, unknown?][]; invocationCallOrder: number[] }
}

function callOrderOf(mock: CommandMock, method: string): number {
  const index = mock.mock.calls.findIndex(([called]) => called === method)
  return mock.mock.invocationCallOrder[index]
}

class FakeBrowserWindow {
  destroyed = false
  url = ''
  /** Where a load lands, when it should end on an error page instead of the URL. */
  loadedUrl: string | null = null
  /** HTTP status the did-navigate listener reports; 0 means a successful load. */
  httpStatus = 0
  httpStatusText = ''
  /** What the page answers to the fixed selector-measure script. */
  measureResult: string | null = null
  /** What the page answers to the failed-load body-text probe. */
  bodyText = ''
  capturePageResult: { toPNG: () => Buffer } | Error = { toPNG: () => PNG }
  private listeners: Record<string, (...args: unknown[]) => void> = {}
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
    on: vi.fn((_event: string, listener: (...args: unknown[]) => void) => {
      this.listeners[_event] = listener
    }),
    off: vi.fn(),
    getTitle: () => 'Example',
    getURL: () => this.url,
    loadURL: vi.fn(async (url: string) => {
      this.url = this.loadedUrl ?? url
      if (this.httpStatus > 0) {
        this.listeners['did-navigate']?.({}, this.url, this.httpStatus, this.httpStatusText)
      }
    }),
    capturePage: vi.fn(async () => {
      if (this.capturePageResult instanceof Error) throw this.capturePageResult
      return this.capturePageResult
    }),
    executeJavaScript: vi.fn(async (script: string) => {
      if (script.includes('querySelector')) return this.measureResult ?? '{"found":false}'
      if (script.includes('document.body')) return this.bodyText
      return ''
    }),
  }
  isDestroyed = () => this.destroyed
  loadURL = vi.fn(async (url: string) => this.webContents.loadURL(url))
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

vi.mock('../../agent/piWorkspaceRuntime.ts', () => ({
  resolvePreviewUrl: (url: string | undefined) =>
    url && !/^[a-z][a-z0-9+.-]*:/i.test(url)
      ? `http://127.0.0.1:41235/${url.replace(/^\/+/, '')}`
      : url,
}))

const { webScreenshotCapability } = await import('../../agent/capabilities/webScreenshot.ts')
const { closeAllBrowserSessions } = await import('../../agent/agentBrowser.ts')

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

async function webShotTool(workspaceDir: string, sessionId = 'web-shot-session'): Promise<Tool> {
  const built = (await webScreenshotCapability.buildTools?.({
    sessionId,
    workspaceDir,
    toolSpecs: [],
  } as never)) as unknown as Tool[]
  return built.find((tool) => tool.name === 'webScreenshot') as Tool
}

const text = (result: { content: { text: string }[] }) => result.content[0].text

function pngFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.png'))
    .map((entry) => entry.name)
}

const capture = async (tool: Tool, params: Record<string, unknown>) =>
  tool.execute('web-shot-1', params)

// The hidden window is created lazily on the first capture; a selector that
// matches nothing fails without writing a file, so it warms the session up for
// the tests that must configure the window before capturing.
const warmUpWindow = async (tool: Tool): Promise<FakeBrowserWindow> => {
  await capture(tool, { url: 'https://example.com', selector: '.warmup' })
  return instances[0]
}

describe('the webScreenshot tool', () => {
  beforeEach(() => {
    instances.length = 0
  })

  afterEach(() => {
    closeAllBrowserSessions()
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('saves a full capture of the page at the workspace root', async () => {
    const workspace = tempDir('aipg-webshot-root-')
    const tool = await webShotTool(workspace)

    const result = await capture(tool, { url: 'https://example.com/page' })

    const files = pngFiles(workspace)
    expect(files).toHaveLength(1)
    expect(fs.statSync(path.join(workspace, files[0])).size).toBe(PNG.length)
    expect(text(result)).toBe(`Saved screenshot to ${files[0]}`)
    expect(result.details).toBeUndefined()
    expect(instances[0].webContents.loadURL).toHaveBeenCalledWith('https://example.com/page')
    expect(instances[0].sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
    })
  })

  it('sets the viewport override before navigating and clears it afterwards', async () => {
    const workspace = tempDir('aipg-webshot-sized-')
    const tool = await webShotTool(workspace)

    const result = await capture(tool, { url: 'https://example.com', width: 900, height: 600 })

    expect(instances[0].sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    })
    expect(
      callOrderOf(instances[0].sendCommand, 'Emulation.setDeviceMetricsOverride'),
    ).toBeLessThan(instances[0].webContents.loadURL.mock.invocationCallOrder[0])
    expect(instances[0].sendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride')
    expect(pngFiles(workspace)).toHaveLength(1)
    expect(text(result)).toMatch(/^Saved screenshot to /)
  })

  it('leaves the viewport alone at the default size', async () => {
    const workspace = tempDir('aipg-webshot-default-')
    const tool = await webShotTool(workspace)

    await capture(tool, { url: 'https://example.com' })

    expect(
      instances[0].sendCommand.mock.calls.some(
        ([method]) => method === 'Emulation.setDeviceMetricsOverride',
      ),
    ).toBe(false)
    expect(
      instances[0].sendCommand.mock.calls.some(
        ([method]) => method === 'Emulation.clearDeviceMetricsOverride',
      ),
    ).toBe(false)
    expect(pngFiles(workspace)).toHaveLength(1)
  })

  it('clamps out-of-range sizes to the 200–4000 bounds', async () => {
    const workspace = tempDir('aipg-webshot-clamp-')
    const tool = await webShotTool(workspace)

    await capture(tool, { url: 'https://example.com', width: 20, height: 99999 })

    expect(instances[0].sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 200,
      height: 4000,
      deviceScaleFactor: 1,
      mobile: false,
    })
    expect(pngFiles(workspace)).toHaveLength(1)
  })

  it('clips the capture to the element a selector names, beyond the viewport', async () => {
    const workspace = tempDir('aipg-webshot-clip-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    window.measureResult = JSON.stringify({
      found: true,
      rect: { x: 10.2, y: 20.7, width: 300, height: 2500 },
    })

    const result = await capture(tool, { url: 'https://example.com', selector: '.pricing' })

    expect(instances[0].sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 10, y: 21, width: 300, height: 2500, scale: 1 },
      captureBeyondViewport: true,
    })
    const files = pngFiles(workspace)
    expect(files).toHaveLength(1)
    expect(text(result)).toBe(`Saved screenshot to ${files[0]}`)
  })

  it('reports a selector that matches nothing and writes no file', async () => {
    const workspace = tempDir('aipg-webshot-missing-')
    const tool = await webShotTool(workspace)

    const result = await capture(tool, { url: 'https://example.com', selector: '.gone' })

    expect(text(result)).toContain('No element matches the selector ".gone"')
    expect(pngFiles(workspace)).toHaveLength(0)
  })

  it('reports a zero-area element and writes no file', async () => {
    const workspace = tempDir('aipg-webshot-zero-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    window.measureResult = JSON.stringify({
      found: true,
      rect: { x: 0, y: 0, width: 0, height: 0 },
    })

    const result = await capture(tool, { url: 'https://example.com', selector: '.hidden' })

    expect(text(result)).toContain('".hidden"')
    expect(text(result)).toMatch(/no visible area/)
    expect(pngFiles(workspace)).toHaveLength(0)
  })

  it('refuses a file:// URL without navigating', async () => {
    const workspace = tempDir('aipg-webshot-file-')
    const tool = await webShotTool(workspace)

    const result = await capture(tool, { url: 'file:///etc/passwd' })

    expect(text(result)).toContain('Refusing to open file:///etc/passwd')
    expect(text(result)).toContain('http(s)')
    // Refused before the session's window is even created, so nothing navigated.
    expect(instances).toHaveLength(0)
    expect(pngFiles(workspace)).toHaveLength(0)
  })

  it('reports an HTTP failure with the server detail and writes no file', async () => {
    const workspace = tempDir('aipg-webshot-http-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    window.httpStatus = 404
    window.httpStatusText = 'Not Found'
    window.bodyText = 'The requested page moved away.'

    const result = await capture(tool, { url: 'https://example.com/gone' })

    expect(text(result)).toContain('Failed to open https://example.com/gone: HTTP 404 Not Found')
    expect(text(result)).toContain('The server said: The requested page moved away.')
    expect(pngFiles(workspace)).toHaveLength(0)
  })

  it('reports a chrome-error load as a failure and writes no file', async () => {
    const workspace = tempDir('aipg-webshot-chrome-error-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    window.loadedUrl = 'chrome-error://chromewebdata/'

    const result = await capture(tool, { url: 'https://unreachable.example.com' })

    expect(text(result)).toContain('failed to load')
    expect(text(result)).toContain('https://unreachable.example.com')
    expect(pngFiles(workspace)).toHaveLength(0)
  })

  it('writes no file when the capture comes back empty', async () => {
    const workspace = tempDir('aipg-webshot-empty-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    window.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Page.captureScreenshot') return { data: '' }
      return {}
    })
    window.capturePageResult = { toPNG: () => Buffer.alloc(0) }

    const result = await capture(tool, { url: 'https://example.com' })

    expect(text(result)).toContain('came back empty')
    expect(pngFiles(workspace)).toHaveLength(0)
  })

  it('resolves a workspace-relative URL against the preview server', async () => {
    const workspace = tempDir('aipg-webshot-preview-')
    const tool = await webShotTool(workspace)

    await capture(tool, { url: 'index.html' })

    expect(instances[0].webContents.loadURL).toHaveBeenCalledWith(
      'http://127.0.0.1:41235/index.html',
    )
    expect(pngFiles(workspace)).toHaveLength(1)
  })
})
