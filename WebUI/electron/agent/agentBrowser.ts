import { BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { appLoggerInstance } from '../observability/logger.ts'
import { freeName } from '../persist/fileOps.ts'
import { isInGamesLibrary } from '../session/sessionWorkspace.ts'
import { formatProbeReport, PROBE_CALL, type ProbeReport } from './previewProbe.ts'
import { recordWorkspaceWrite } from './workspaceJournal.ts'

// ── Agent browser (Electron-native) ──────────────────────────────────────────
//
// A headless preview/debug browser for Agent Mode that reuses ELECTRON'S OWN
// bundled Chromium — no Playwright, no separate browser download, no extra
// packaging. One hidden BrowserWindow per agent session; the Chrome DevTools
// Protocol (exposed on every webContents via `webContents.debugger`) captures
// console output AND uncaught exceptions with full fidelity — the same protocol
// the Chrome DevTools MCP speaks, but on the bundled engine and behind a single
// small tool instead of 29 MCP schemas.

const logger = appLoggerInstance
const LOG_SOURCE = 'agentBrowser'

type BrowserSession = {
  win: BrowserWindow
  /** Console messages + uncaught exceptions captured since the last `open`. */
  logs: string[]
  attached: boolean
}

const sessions = new Map<string, BrowserSession>()

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Best-effort flattening of a CDP Runtime.RemoteObject into a log string. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatRemoteObject(arg: any): string {
  if (arg == null) return ''
  if (arg.value !== undefined) {
    return typeof arg.value === 'object' ? JSON.stringify(arg.value) : String(arg.value)
  }
  return arg.description ?? arg.unserializableValue ?? arg.type ?? ''
}

function ensureBrowserSession(sessionId: string): BrowserSession {
  const existing = sessions.get(sessionId)
  if (existing && !existing.win.isDestroyed()) return existing

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  // This window is never shown, so a game's sound would come from nowhere and
  // outlive the play-test that started it — the page stays loaded all session.
  win.webContents.setAudioMuted(true)
  const session: BrowserSession = { win, logs: [], attached: false }

  // Prefer the CDP debugger (captures console.* AND uncaught exceptions). Fall
  // back to the plain console-message event (console.* only) if attach fails.
  try {
    win.webContents.debugger.attach('1.3')
    session.attached = true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    win.webContents.debugger.on('message', (_event, method: string, params: any) => {
      if (method === 'Runtime.consoleAPICalled') {
        const text = (params.args ?? []).map(formatRemoteObject).join(' ')
        session.logs.push(`[${params.type}] ${text}`)
      } else if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails
        const message = details?.exception?.description ?? details?.text ?? 'Uncaught exception'
        session.logs.push(`[error] ${message}`)
      } else if (method === 'Log.entryAdded') {
        session.logs.push(`[${params.entry.level}] ${params.entry.text}`)
      }
    })
    void win.webContents.debugger.sendCommand('Runtime.enable')
    void win.webContents.debugger.sendCommand('Log.enable')
  } catch (error) {
    logger.warn(`CDP attach failed, falling back to console-message: ${error}`, LOG_SOURCE)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    win.webContents.on('console-message', (event: any) => {
      const level = event?.level ?? 'log'
      const message = event?.message ?? String(event ?? '')
      session.logs.push(`[${level}] ${message}`)
    })
  }

  sessions.set(sessionId, session)
  return session
}

/**
 * Run the script inside its own try/catch in the page, reporting what actually
 * went wrong. Electron rejects a throwing `executeJavaScript` with one fixed
 * sentence ("Script failed to execute … check the renderer console"), which is
 * useless to a model that cannot read that console: it just guesses another
 * script. The real message ("move is not defined") ends the guessing.
 *
 * Models write both forms — a bare expression and a statement list ending in
 * `return` — so the page compiles an expression wrapper first and, only when
 * that fails to parse, compiles the script as statements. The script is passed
 * in as data; compiling it here would run untrusted source in the main process.
 * A runtime failure is not a parse failure: retrying it would run the script twice.
 */
function wrapForEval(script: string): string {
  return `(async () => {
    const script = ${JSON.stringify(script)}
    const compile = Object.getPrototypeOf(async function () {}).constructor
    try {
      let runner
      try {
        runner = new compile('return (\\n' + script + '\\n)')
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        runner = new compile(script)
      }
      const value = await runner()
      // Stringified in the page: the result may be a DOM node or a cycle, which
      // could not cross the IPC boundary as-is.
      try {
        return { ok: true, text: typeof value === 'string' ? value : JSON.stringify(value) }
      } catch {
        return { ok: true, text: String(value) }
      }
    } catch (error) {
      return { ok: false, error: String((error && error.stack) || error) }
    }
  })()`
}

export type CaptureClip = { x: number; y: number; width: number; height: number }

/**
 * CDP yields a frame even while the window is hidden; an empty capture is a failure, never a
 * 0-byte file. A clip is captured beyond the viewport, so an element taller than the window
 * still comes out whole.
 */
async function captureScreenshotPng(
  session: BrowserSession,
  clip?: CaptureClip,
): Promise<Buffer | null> {
  if (session.attached) {
    try {
      const shot = (await session.win.webContents.debugger.sendCommand('Page.captureScreenshot', {
        format: 'png',
        ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}),
      })) as { data?: unknown } | undefined
      const data = typeof shot?.data === 'string' ? shot.data : ''
      const png = data ? Buffer.from(data, 'base64') : Buffer.alloc(0)
      if (png.length > 0) return png
    } catch (error) {
      logger.warn(`CDP screenshot failed, falling back to capturePage: ${error}`, LOG_SOURCE)
    }
  }
  try {
    const png = await session.win.webContents
      .capturePage(
        clip ? { x: clip.x, y: clip.y, width: clip.width, height: clip.height } : undefined,
      )
      .then((image) => image.toPNG())
    return png.length > 0 ? png : null
  } catch (error) {
    logger.warn(`capturePage screenshot failed: ${error}`, LOG_SOURCE)
    return null
  }
}

/**
 * Save a capture under the workspace rules: the workspace root, or `generated/`
 * in the games library, under a collision-safe timestamped name. Returns the
 * workspace-relative path.
 */
async function saveScreenshotPng(
  sessionId: string,
  workspaceDir: string,
  png: Buffer,
): Promise<string> {
  const inGame = isInGamesLibrary(workspaceDir)
  const dir = inGame ? path.join(workspaceDir, 'generated') : workspaceDir
  fs.mkdirSync(dir, { recursive: true })
  const filename = await freeName(dir, `screenshot-${Date.now()}.png`)
  const target = path.join(dir, filename)
  recordWorkspaceWrite(sessionId, target)
  fs.writeFileSync(target, png)
  return inGame ? path.posix.join('generated', filename) : filename
}

// Models otherwise embed the path as a markdown image, which the chat cannot load.
/** The model-facing report of a saved capture, shared by both screenshot tools. */
export function savedScreenshotText(relativePath: string): string {
  return (
    `Saved screenshot to ${relativePath}. The user already sees this picture in the chat, ` +
    'so refer to it by this path only — do not embed it as a markdown image or link.'
  )
}

export type BrowserToolInput = {
  action: 'open' | 'console' | 'eval' | 'screenshot' | 'probe'
  url?: string
  script?: string
}

export type BrowserActionResult = {
  /** What the model is told. */
  text: string
  /** Workspace-relative path of a screenshot this action produced, for the UI. */
  screenshotPath?: string
}

/**
 * Execute one browser action for a session. Runs in the Electron main process
 * against a hidden BrowserWindow (bundled Chromium). Returns a plain string for
 * the model. A screenshot is saved at the workspace root, or in its `generated/`
 * folder inside the games library, and the tool returns the workspace-relative
 * PATH (never base64 — that overflows context).
 */
export async function runBrowserAction(
  sessionId: string,
  workspaceDir: string,
  input: BrowserToolInput,
): Promise<BrowserActionResult> {
  const session = ensureBrowserSession(sessionId)
  switch (input.action) {
    case 'open': {
      if (!input.url) throw new Error("browser 'open' requires a url")
      session.logs.length = 0
      // `loadURL` resolves for an error response just as it does for a page, so
      // without the navigation status a 404/500 looks like a successful open and
      // the model debugs a page the server never served.
      let status = 0
      let statusText = ''
      const onNavigate = (_event: unknown, _url: string, code: number, text: string) => {
        status = code
        statusText = text
      }
      session.win.webContents.on('did-navigate', onNavigate)
      try {
        await session.win.loadURL(input.url)
      } finally {
        session.win.webContents.off('did-navigate', onNavigate)
      }
      // Let late async console output / errors settle before returning.
      await delay(400)
      if (status >= 400) {
        const body = await session.win.webContents
          .executeJavaScript('document.body?.innerText ?? ""', true)
          .catch(() => '')
        const detail = String(body).trim().slice(0, 300)
        return {
          text:
            `Failed to open ${input.url}: HTTP ${status} ${statusText}.` +
            (detail ? ` The server said: ${detail}` : ''),
        }
      }
      const title = session.win.webContents.getTitle()
      // The error count rides along on the open: a model that forgets to ask for
      // the console otherwise debugs a page it never learned was throwing.
      const errors = session.logs.filter((line) => line.startsWith('[error]')).length
      const trouble =
        errors > 0
          ? ` ${errors} console error${errors === 1 ? '' : 's'} already — read them with the` +
            ' console action.'
          : ''
      return { text: `Opened ${input.url}${title ? ` (title: ${title})` : ''}.${trouble}` }
    }
    case 'console':
      return { text: session.logs.length > 0 ? session.logs.join('\n') : '<no console messages>' }
    case 'eval': {
      if (!input.script) throw new Error("browser 'eval' requires a script")
      const outcome = (await session.win.webContents.executeJavaScript(
        wrapForEval(input.script),
        true,
      )) as { ok: boolean; text?: string; error?: string }
      if (!outcome?.ok) {
        throw new Error(`The script threw: ${outcome?.error ?? 'unknown error'}`)
      }
      return { text: outcome.text ?? 'undefined' }
    }
    case 'probe': {
      const raw = (await session.win.webContents.executeJavaScript(
        wrapForEval(PROBE_CALL),
        true,
      )) as { ok: boolean; text?: string; error?: string }
      if (!raw?.ok) {
        throw new Error(`The probe failed to run: ${raw?.error ?? 'unknown error'}`)
      }
      let report: ProbeReport
      try {
        report = JSON.parse(raw.text ?? '{}') as ProbeReport
      } catch {
        return { text: `The probe returned something unreadable: ${raw.text ?? '(nothing)'}` }
      }
      return { text: formatProbeReport(report) }
    }
    case 'screenshot': {
      const url = session.win.webContents.getURL()
      if (!url || url === 'about:blank') {
        return {
          text:
            'No page is open in the browser, so there is nothing to capture. Open one first ' +
            'with action "open" (for example {"action":"open","url":"index.html"}), then take ' +
            'the screenshot again.',
        }
      }
      if (url.startsWith('chrome-error://')) {
        return {
          text:
            'The page failed to load, so the browser has no page to capture. Open it again ' +
            'with action "open" (checking the URL), then take the screenshot again.',
        }
      }
      const png = await captureScreenshotPng(session)
      if (!png) {
        return {
          text:
            'The screenshot came back empty, so no image was saved. Reload the page with ' +
            'action "open" and try the screenshot again.',
        }
      }
      const relativePath = await saveScreenshotPng(sessionId, workspaceDir, png)
      return { text: savedScreenshotText(relativePath), screenshotPath: relativePath }
    }
    default:
      throw new Error(`Unknown browser action: ${String((input as BrowserToolInput).action)}`)
  }
}

export type WebsiteCaptureInput = {
  url: string
  /** Viewport width in pixels; with `height`, sizes the capture for one call. */
  width?: number
  height?: number
  /** Visible text of the single element to capture instead of the whole page. */
  text?: string
}

const VIEWPORT_MIN = 200
const VIEWPORT_MAX = 4000
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

function clampViewport(value: number): number {
  return Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, Math.round(value)))
}

// A fixed script of ours; the quote rides along as JSON data, never compiled (ADR 0015).
// The read script's image list may fall back to title; this matcher matches alt/aria-label only.
function textMatchRectScript(quote: string): string {
  return `(async () => {
  const normalize = (value) => String(value).toLowerCase().replace(/\\s+/g, ' ').trim()
  const wanted = normalize(${JSON.stringify(quote)})
  if (!wanted) return JSON.stringify({ matches: 0 })
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TITLE'])
  const matched = []
  for (const element of document.querySelectorAll('*')) {
    if (skip.has(element.tagName)) continue
    if (normalize(element.innerText ?? '').includes(wanted)) {
      matched.push(element)
      continue
    }
    const named = ['alt', 'aria-label'].some(
      (name) => normalize(element.getAttribute(name) ?? '').includes(wanted),
    )
    if (named) matched.push(element)
  }
  const distinct = matched.filter(
    (element) => !matched.some((other) => other !== element && element.contains(other)),
  )
  if (distinct.length !== 1) return JSON.stringify({ matches: distinct.length })
  const rect = distinct[0].getBoundingClientRect()
  return JSON.stringify({
    matches: 1,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
  })
})()`
}

/**
 * Navigate the session's hidden browser to a page and save a PNG of it — the
 * capture-only half of the `browser` tool, reached by `webScreenshot` and not
 * part of its action dispatch. Refuses anything but http(s) in code: `file://`
 * in this window would render local files outside the mounted-folder
 * containment. A non-default viewport is a CDP override that is cleared again
 * before returning, so the shared window is untouched by the time the next
 * action runs.
 */
export async function captureWebsite(
  sessionId: string,
  workspaceDir: string,
  input: WebsiteCaptureInput,
): Promise<BrowserActionResult> {
  let target: URL
  try {
    target = new URL(input.url)
  } catch {
    return {
      text: `Cannot capture "${input.url}": it is not a valid URL. Give the page's full http(s) URL.`,
    }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return {
      text:
        `Refusing to open ${input.url}: only http(s) pages can be captured. ` +
        "This tool cannot render local files — give the page's full http(s) URL.",
    }
  }

  const session = ensureBrowserSession(sessionId)
  const width =
    typeof input.width === 'number' && Number.isFinite(input.width) ? input.width : undefined
  const height =
    typeof input.height === 'number' && Number.isFinite(input.height) ? input.height : undefined
  const clamped =
    width !== undefined || height !== undefined
      ? {
          width: clampViewport(width ?? DEFAULT_VIEWPORT.width),
          height: clampViewport(height ?? DEFAULT_VIEWPORT.height),
        }
      : DEFAULT_VIEWPORT
  let overrideSet = false
  if (clamped.width !== DEFAULT_VIEWPORT.width || clamped.height !== DEFAULT_VIEWPORT.height) {
    // The override on a never-navigated window segfaults the main process: it has no view yet.
    if (!session.win.webContents.getURL()) await session.win.loadURL('about:blank')
    try {
      await session.win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: clamped.width,
        height: clamped.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      overrideSet = true
    } catch (error) {
      logger.warn(`viewport override failed, capturing at the window's size: ${error}`, LOG_SOURCE)
    }
  }

  try {
    session.logs.length = 0
    let status = 0
    let statusText = ''
    const onNavigate = (_event: unknown, _url: string, code: number, phrase: string) => {
      status = code
      statusText = phrase
    }
    session.win.webContents.on('did-navigate', onNavigate)
    try {
      await session.win.loadURL(input.url)
    } finally {
      session.win.webContents.off('did-navigate', onNavigate)
    }
    // Let late async content settle before capturing.
    await delay(400)
    const landed = session.win.webContents.getURL()
    if (landed.startsWith('chrome-error://')) {
      return {
        text:
          `The page failed to load (${input.url}), so no screenshot was taken. ` +
          'Check the URL and try again.',
      }
    }
    if (status >= 400) {
      const body = await session.win.webContents
        .executeJavaScript('document.body?.innerText ?? ""', true)
        .catch(() => '')
      const detail = String(body).trim().slice(0, 300)
      return {
        text:
          `Failed to open ${input.url}: HTTP ${status} ${statusText}.` +
          (detail ? ` The server said: ${detail}` : ''),
      }
    }

    let clip: CaptureClip | undefined
    if (input.text) {
      const couldNotSearch =
        `Could not search ${input.url} for the text "${input.text}", so no screenshot ` +
        'was taken. Try the capture again.'
      const raw = await session.win.webContents
        .executeJavaScript(textMatchRectScript(input.text), true)
        .catch(() => '')
      let report: {
        matches?: number
        rect?: { x: number; y: number; width: number; height: number }
      }
      try {
        report = JSON.parse(String(raw)) as typeof report
      } catch {
        return { text: couldNotSearch }
      }
      const count = typeof report.matches === 'number' ? report.matches : 0
      if (count === 0) {
        return {
          text:
            `No element on ${input.url} contains the text "${input.text}", so no screenshot ` +
            'was taken. Read the page with the web tools, then quote the visible text of ' +
            "the element — or an image's alt text — exactly as the page shows it.",
        }
      }
      if (count > 1) {
        return {
          text:
            `The text "${input.text}" matches ${count} distinct elements on ${input.url}, so ` +
            "no screenshot was taken. Quote more of the element's text so exactly one " +
            'element matches.',
        }
      }
      if (!report.rect) return { text: couldNotSearch }
      const { x, y, width: w, height: h } = report.rect
      if (!(w > 0) || !(h > 0)) {
        return {
          text:
            `The element containing "${input.text}" has no visible area on ${input.url}, ` +
            'so no screenshot was taken. Pick an element that is displayed.',
        }
      }
      // The rect is viewport-relative; with no scroll action it coincides with page coordinates.
      clip = { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }
    }

    const png = await captureScreenshotPng(session, clip)
    if (!png) {
      return {
        text:
          'The screenshot came back empty, so no image was saved. Try the capture again' +
          (input.text ? ' — maybe without the text, to capture the whole page.' : '.'),
      }
    }
    const relativePath = await saveScreenshotPng(sessionId, workspaceDir, png)
    return { text: savedScreenshotText(relativePath), screenshotPath: relativePath }
  } finally {
    if (overrideSet) {
      try {
        await session.win.webContents.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
      } catch (error) {
        logger.warn(`could not clear the viewport override: ${error}`, LOG_SOURCE)
      }
    }
  }
}

/** Tear down a session's browser window (called on agent session teardown). */
export function closeBrowserSession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return
  sessions.delete(sessionId)
  try {
    if (!session.win.isDestroyed()) {
      if (session.attached) session.win.webContents.debugger.detach()
      session.win.destroy()
    }
  } catch (error) {
    logger.warn(`failed to close agent browser: ${error}`, LOG_SOURCE)
  }
}

/**
 * Tear down every session's browser window, whether or not a workspace runtime
 * still points at it.
 *
 * These windows are hidden but very much alive, and Electron only emits
 * `window-all-closed` once every window is destroyed. One survivor therefore
 * keeps the app running after the user closes the main window: the teardown
 * never runs, the backends stay up, and the single-instance lock stays held, so
 * the next launch is refused. Per-session cleanup alone cannot guarantee this —
 * a session whose runtime never started, or was replaced, is not reachable from
 * it — so app shutdown sweeps the whole map.
 */
export function closeAllBrowserSessions(): void {
  for (const sessionId of [...sessions.keys()]) closeBrowserSession(sessionId)
}
