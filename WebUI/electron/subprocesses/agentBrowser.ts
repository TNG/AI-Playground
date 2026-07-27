import { BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { appLoggerInstance } from '../logging/logger.ts'

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

export type BrowserToolInput = {
  action: 'open' | 'console' | 'eval' | 'screenshot'
  url?: string
  script?: string
}

/**
 * Execute one browser action for a session. Runs in the Electron main process
 * against a hidden BrowserWindow (bundled Chromium). Returns a plain string for
 * the model. Screenshots are saved into `<workspace>/generated/` and the tool
 * returns the workspace-relative PATH (never base64 — that overflows context).
 */
export async function runBrowserAction(
  sessionId: string,
  workspaceDir: string,
  input: BrowserToolInput,
): Promise<string> {
  const session = ensureBrowserSession(sessionId)
  switch (input.action) {
    case 'open': {
      if (!input.url) throw new Error("browser 'open' requires a url")
      session.logs.length = 0
      await session.win.loadURL(input.url)
      // Let late async console output / errors settle before returning.
      await delay(400)
      const title = session.win.webContents.getTitle()
      return `Opened ${input.url}${title ? ` (title: ${title})` : ''}.`
    }
    case 'console':
      return session.logs.length > 0 ? session.logs.join('\n') : '<no console messages>'
    case 'eval': {
      if (!input.script) throw new Error("browser 'eval' requires a script")
      const result = await session.win.webContents.executeJavaScript(input.script, true)
      return typeof result === 'string' ? result : JSON.stringify(result ?? null)
    }
    case 'screenshot': {
      const image = await session.win.webContents.capturePage()
      const generatedDir = path.join(workspaceDir, 'generated')
      fs.mkdirSync(generatedDir, { recursive: true })
      const filename = `screenshot-${Date.now()}.png`
      fs.writeFileSync(path.join(generatedDir, filename), image.toPNG())
      return `Saved screenshot to ${path.posix.join('generated', filename)}`
    }
    default:
      throw new Error(`Unknown browser action: ${String((input as BrowserToolInput).action)}`)
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
