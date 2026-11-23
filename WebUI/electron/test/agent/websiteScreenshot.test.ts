import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The Website screenshots `webScreenshot` tool, driven through the capability
// against the real capture engine, with only Electron's window and web contents
// faked. The fixed text-match script runs for real, against a fixture page the
// fake window hands to `executeJavaScript`.

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001',
  'hex',
)

/** A fixture element: exactly the surface the fixed match script touches in a page. */
type ElementSpec = {
  tag: string
  text?: string
  alt?: string
  ariaLabel?: string
  rect?: { x: number; y: number; width: number; height: number }
  children?: ElementSpec[]
}

type FixtureElement = {
  tagName: string
  innerText: string
  parent: FixtureElement | null
  getAttribute: (name: string) => string | null
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number }
  contains: (other: FixtureElement) => boolean
}

/** An element's visible text includes its descendants', the way innerText does. */
const subtreeText = (spec: ElementSpec): string =>
  [spec.text ?? '', ...(spec.children ?? []).map(subtreeText)].join(' ').trim()

/** Build a fixture page; returns every element in document order. */
function buildPage(specs: ElementSpec[]): FixtureElement[] {
  const all: FixtureElement[] = []
  const build = (spec: ElementSpec, parent: FixtureElement | null): FixtureElement => {
    const element = {} as FixtureElement
    const rect = spec.rect ?? { x: 0, y: 0, width: 100, height: 40 }
    element.tagName = spec.tag
    element.innerText = subtreeText(spec)
    element.parent = parent
    element.getAttribute = (name: string) =>
      name === 'alt' && spec.alt !== undefined
        ? spec.alt
        : name === 'aria-label' && spec.ariaLabel !== undefined
          ? spec.ariaLabel
          : null
    element.getBoundingClientRect = () => rect
    element.contains = (other: FixtureElement) => {
      let cursor: FixtureElement | null = other
      while (cursor) {
        if (cursor === element) return true
        cursor = cursor.parent
      }
      return false
    }
    all.push(element)
    for (const child of spec.children ?? []) build(child, element)
    return element
  }
  for (const spec of specs) build(spec, null)
  return all
}

/** Run the engine's fixed match script against a fixture page, as the page would. */
async function runMatchScript(script: string, page: FixtureElement[]): Promise<string> {
  const document = { querySelectorAll: () => page }
  const runner = new Function('document', `return ${script}`)
  return (await runner(document)) as string
}

type CommandMock = {
  mock: { calls: [string, unknown?][]; invocationCallOrder: number[] }
}

function callOrderOf(mock: CommandMock, method: string): number {
  const index = mock.mock.calls.findIndex(([called]) => called === method)
  return mock.mock.invocationCallOrder[index]
}

function loadOrderOf(win: FakeBrowserWindow, url: string): number {
  const { calls, invocationCallOrder } = win.webContents.loadURL.mock
  return invocationCallOrder[calls.findIndex(([loaded]) => loaded === url)]
}

class FakeBrowserWindow {
  destroyed = false
  url = ''
  /** Where a load lands, when it should end on an error page instead of the URL. */
  loadedUrl: string | null = null
  /** HTTP status the did-navigate listener reports; 0 means a successful load. */
  httpStatus = 0
  httpStatusText = ''
  /** The fixture page the fixed text-match script runs against. */
  page: FixtureElement[] = []
  /** What the page answers to the failed-load body-text probe. */
  bodyText = ''
  /** Raw answer of the fixed text-match script, overriding the fixture page. */
  matchScriptResult: string | null = null
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
      if (script.includes('document.querySelectorAll'))
        return this.matchScriptResult ?? runMatchScript(script, this.page)
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

// The hidden window is created lazily on the first capture; a quote that
// matches nothing fails without writing a file, so it warms the session up for
// the tests that must configure the page before capturing.
const warmUpWindow = async (tool: Tool): Promise<FakeBrowserWindow> => {
  await capture(tool, { url: 'https://example.com', text: 'warm up: nothing matches this' })
  return instances[0]
}

describe('the webScreenshot tool', () => {
  it('offers text for element capture and rejects a selector outright', async () => {
    const workspace = tempDir('aipg-webshot-schema-')
    const tool = await webShotTool(workspace)

    const schema = (tool as unknown as { parameters: Record<string, unknown> }).parameters
    const properties = schema.properties as Record<string, unknown>

    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['url'])
    expect(properties.text).toBeDefined()
    expect(properties.selector).toBeUndefined()
  })

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

  it('saves a full capture of the page at the workspace root', async () => {
    const workspace = tempDir('aipg-webshot-root-')
    const tool = await webShotTool(workspace)

    const result = await capture(tool, { url: 'https://example.com/page' })

    const files = pngFiles(workspace)
    expect(files).toHaveLength(1)
    expect(fs.statSync(path.join(workspace, files[0])).size).toBe(PNG.length)
    expect(text(result)).toBe(savedScreenshotText(files[0]))
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
    ).toBeLessThan(loadOrderOf(instances[0], 'https://example.com'))
    expect(instances[0].sendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride')
    expect(pngFiles(workspace)).toHaveLength(1)
    expect(text(result)).toMatch(/^Saved screenshot to /)
  })

  it('gives a never-navigated window a blank page before the viewport override', async () => {
    const workspace = tempDir('aipg-webshot-fresh-')
    const tool = await webShotTool(workspace)

    await capture(tool, { url: 'https://example.com', width: 1280, height: 1200 })

    expect(loadOrderOf(instances[0], 'about:blank')).toBeLessThan(
      callOrderOf(instances[0].sendCommand, 'Emulation.setDeviceMetricsOverride'),
    )
  })

  it('skips the blank page once the window holds a page', async () => {
    const workspace = tempDir('aipg-webshot-warm-')
    const tool = await webShotTool(workspace)
    const win = await warmUpWindow(tool)

    await capture(tool, { url: 'https://example.com', width: 1280, height: 1200 })

    expect(win.webContents.loadURL).not.toHaveBeenCalledWith('about:blank')
    expect(win.sendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.anything(),
    )
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

  it('leaves the viewport alone when the default size is passed explicitly', async () => {
    const workspace = tempDir('aipg-webshot-explicit-')
    const tool = await webShotTool(workspace)

    await capture(tool, { url: 'https://example.com', width: 1280, height: 800 })

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

  it('clips the capture to the element the quoted text names, beyond the viewport', async () => {
    const workspace = tempDir('aipg-webshot-clip-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    window.page = buildPage([
      {
        tag: 'SECTION',
        rect: { x: 0, y: 0, width: 1200, height: 3000 },
        children: [
          { tag: 'H2', text: 'Pricing', rect: { x: 10.2, y: 20.7, width: 300, height: 40 } },
          {
            tag: 'TABLE',
            text: 'Basic Pro Enterprise',
            rect: { x: 10, y: 80, width: 600, height: 2500 },
          },
        ],
      },
    ])

    const result = await capture(tool, { url: 'https://example.com', text: 'Pricing' })

    expect(instances[0].sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 10, y: 21, width: 300, height: 40, scale: 1 },
      captureBeyondViewport: true,
    })
    const files = pngFiles(workspace)
    expect(files).toHaveLength(1)
    expect(text(result)).toBe(savedScreenshotText(files[0]))
    // The quote rides inside the fixed script as JSON data, never compiled.
    const calls = instances[0].webContents.executeJavaScript.mock.calls
    expect(calls[calls.length - 1][0]).toContain('"Pricing"')
  })

  it('matches an element by its alt or aria-label attribute', async () => {
    const workspace = tempDir('aipg-webshot-alt-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)

    window.page = buildPage([
      {
        tag: 'IMG',
        alt: 'Quarterly revenue chart',
        rect: { x: 5, y: 5, width: 400, height: 300 },
      },
    ])
    await capture(tool, { url: 'https://example.com', text: 'Quarterly revenue chart' })
    expect(instances[0].sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 5, y: 5, width: 400, height: 300, scale: 1 },
      captureBeyondViewport: true,
    })

    window.page = buildPage([
      {
        tag: 'BUTTON',
        ariaLabel: 'Open the menu',
        rect: { x: 1, y: 2, width: 30, height: 30 },
      },
    ])
    await capture(tool, { url: 'https://example.com', text: 'open THE   menu' })
    expect(instances[0].sendCommand).toHaveBeenLastCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 1, y: 2, width: 30, height: 30, scale: 1 },
      captureBeyondViewport: true,
    })
    expect(pngFiles(workspace)).toHaveLength(2)
  })

  it('ignores case and whitespace differences when matching the quote', async () => {
    const workspace = tempDir('aipg-webshot-case-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    window.page = buildPage([
      {
        tag: 'P',
        text: 'Simple plans for every team',
        rect: { x: 12, y: 34, width: 500, height: 20 },
      },
    ])

    await capture(tool, {
      url: 'https://example.com',
      text: '  SIMPLE   plans\n\tfor EVERY  team ',
    })

    expect(instances[0].sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 12, y: 34, width: 500, height: 20, scale: 1 },
      captureBeyondViewport: true,
    })
    expect(pngFiles(workspace)).toHaveLength(1)
  })

  it('captures the deepest element containing the quote — narrow inside, wide for a section', async () => {
    const workspace = tempDir('aipg-webshot-deepest-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    const sectionRect = { x: 0, y: 0, width: 1200, height: 800 }
    const paragraphRect = { x: 20, y: 60, width: 500, height: 20 }
    window.page = buildPage([
      {
        tag: 'SECTION',
        text: 'Pricing',
        rect: sectionRect,
        children: [{ tag: 'P', text: 'Simple plans for every team.', rect: paragraphRect }],
      },
    ])

    await capture(tool, { url: 'https://example.com', text: 'Simple plans for every team.' })
    expect(instances[0].sendCommand).toHaveBeenLastCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { ...paragraphRect, scale: 1 },
      captureBeyondViewport: true,
    })

    await capture(tool, {
      url: 'https://example.com',
      text: 'Pricing Simple plans for every team.',
    })
    expect(instances[0].sendCommand).toHaveBeenLastCalledWith('Page.captureScreenshot', {
      format: 'png',
      clip: { ...sectionRect, scale: 1 },
      captureBeyondViewport: true,
    })
    expect(pngFiles(workspace)).toHaveLength(2)
  })

  it('reports a quote that matches nothing and writes no file', async () => {
    const workspace = tempDir('aipg-webshot-missing-')
    const tool = await webShotTool(workspace)

    const result = await capture(tool, { url: 'https://example.com', text: 'Not on this page' })

    expect(text(result)).toContain('contains the text "Not on this page"')
    expect(text(result)).toContain('no screenshot was taken')
    expect(pngFiles(workspace)).toHaveLength(0)
  })

  it('reports a quote with several distinct matches and writes no file', async () => {
    const workspace = tempDir('aipg-webshot-multi-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    window.page = buildPage([
      {
        tag: 'DIV',
        children: [{ tag: 'H2', text: 'Pricing', rect: { x: 0, y: 0, width: 200, height: 30 } }],
      },
      {
        tag: 'DIV',
        children: [{ tag: 'H2', text: 'Pricing', rect: { x: 0, y: 100, width: 200, height: 30 } }],
      },
    ])

    const result = await capture(tool, { url: 'https://example.com', text: 'Pricing' })

    expect(text(result)).toContain('matches 2 distinct elements')
    expect(text(result)).toMatch(/[Qq]uote more/)
    expect(pngFiles(workspace)).toHaveLength(0)
  })

  it('reports a matched element with no visible area and writes no file', async () => {
    const workspace = tempDir('aipg-webshot-zero-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    window.page = buildPage([
      {
        tag: 'DIV',
        text: 'Invisible block',
        rect: { x: 0, y: 0, width: 0, height: 0 },
      },
    ])

    const result = await capture(tool, { url: 'https://example.com', text: 'Invisible block' })

    expect(text(result)).toContain('"Invisible block"')
    expect(text(result)).toMatch(/no visible area/)
    expect(pngFiles(workspace)).toHaveLength(0)
  })

  it('reports a match report without a rect as a failed search, not an invisible element', async () => {
    const workspace = tempDir('aipg-webshot-norect-')
    const tool = await webShotTool(workspace)
    const window = await warmUpWindow(tool)
    window.matchScriptResult = JSON.stringify({ matches: 1 })

    const result = await capture(tool, { url: 'https://example.com', text: 'Quarterly results' })

    expect(text(result)).toContain('Could not search https://example.com')
    expect(text(result)).toContain('no screenshot was taken')
    expect(text(result)).not.toContain('no visible area')
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

  it('keeps a game workspace capture in generated/', async () => {
    const home = tempDir('aipg-webshot-home-')
    delete process.env.USERPROFILE
    process.env.HOME = home
    const workspace = path.join(home, 'AI-Playground', 'games', 'Star Blaster')
    fs.mkdirSync(workspace, { recursive: true })
    const tool = await webShotTool(workspace)

    const result = await capture(tool, { url: 'https://example.com' })

    const saved = fs.readdirSync(path.join(workspace, 'generated'))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatch(/^screenshot-\d+\.png$/)
    expect(text(result)).toBe(savedScreenshotText(`generated/${saved[0]}`))
    expect(pngFiles(workspace)).toHaveLength(0)
  })
})
