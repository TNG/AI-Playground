import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromium, type Browser, type Page } from '@playwright/test'
import {
  injectProbe,
  PROBE_CALL,
  PROBE_PATH,
  PROBE_SCRIPT,
  type ProbeReport,
} from '../../../electron/agentMode/previewProbe.ts'

// ── Play-testing a finished game, for the judge ──────────────────────────────
//
// The judge is asked "does it work, does it match the brief, does it look good,
// how buggy is it", and only the last three are questions for a model. Whether
// the page runs at all is a fact, and it is collected here the same way the
// agent collects it during a run: the play-test probe (previewProbe.ts) grafted
// into the page by a loopback preview server. Reusing that module rather than
// re-deriving "is this animating" keeps the judge's ground truth identical to
// the agent's, so a game that probed clean while being built cannot probe
// differently while being scored.
//
// What is new here is the playing. The agent's probe presses two keys for a
// quarter-second each, which answers "does anything react"; it does not answer
// "is this a game". So a real Chromium plays for ten-odd seconds — clicking to
// get past a title screen, holding the game's own keys, moving the pointer —
// while recording video and taking stills. The clip is what the vision model
// judges; the probe taken before and after brackets it, and a score or phase
// that moved between the two is evidence no picture can fake.
//
// Nothing here writes into the game folder: a judged game is left exactly as
// its author left it, and every artifact lands in the run's output directory.

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
}

export type PreviewServer = {
  baseUrl: string
  close: () => Promise<void>
}

/**
 * Serve a game folder on loopback with the probe grafted into every page, the
 * way `piWorkspaceRuntime` serves an agent workspace. That module cannot be
 * imported here — it pulls in Electron — so this is the same contract written
 * small: GET/HEAD only, no caching, nothing outside the folder, and the probe
 * answered before the folder is consulted so a file of that name cannot shadow
 * it.
 */
export function startPreviewServer(root: string): Promise<PreviewServer> {
  const server = http.createServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405)
        res.end('Method Not Allowed')
        return
      }
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
      if (urlPath === PROBE_PATH) {
        send(req, res, Buffer.from(PROBE_SCRIPT, 'utf-8'), CONTENT_TYPES['.js'])
        return
      }
      let fullPath = path.resolve(root, '.' + urlPath)
      const relative = path.relative(root, fullPath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      let stat: fs.Stats
      try {
        stat = fs.statSync(fullPath)
      } catch {
        // Chromium asks for this unprompted; a 404 would land in the console
        // errors the judge is told to take seriously.
        res.writeHead(urlPath === '/favicon.ico' ? 204 : 404)
        res.end()
        return
      }
      if (stat.isDirectory()) {
        fullPath = path.join(fullPath, 'index.html')
        if (!fs.existsSync(fullPath)) {
          res.writeHead(404)
          res.end('Not Found')
          return
        }
      }
      const extension = path.extname(fullPath).toLowerCase()
      const contentType = CONTENT_TYPES[extension] ?? 'application/octet-stream'
      const body = fs.readFileSync(fullPath)
      if (extension === '.html' || extension === '.htm') {
        send(req, res, Buffer.from(injectProbe(body.toString('utf-8')), 'utf-8'), contentType)
        return
      }
      send(req, res, body, contentType)
    } catch {
      res.writeHead(500)
      res.end('Internal Server Error')
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        baseUrl: `http://127.0.0.1:${port}/`,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

function send(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: Buffer,
  contentType: string,
): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}

// ── Which keys to play with ──────────────────────────────────────────────────

const DEFAULT_KEYS = ['ArrowLeft', 'ArrowRight', 'Space', 'ArrowUp', 'ArrowDown']

/**
 * The keys the game says it wants. `design.md` has a one-line **Controls** entry
 * by the skill's own template, and playing a shooter's actual keys is the
 * difference between a clip of a game being played and a clip of a title screen
 * being ignored. Anything unparseable falls back to arrows plus space, which is
 * what the scaffold binds.
 *
 * Models write that line for people, so directions arrive as glyphs (`←/→`) and
 * letter keys as pairs (`A/D`) at least as often as they arrive as words. Missing
 * those costs the run its movement keys, and a platformer played with jump alone
 * never leaves the first ledge — which reads as a working game to the judge.
 */
export function derivePlayKeys(design: string | null): string[] {
  const line = design
    ?.split('\n')
    .find((candidate) => /controls/i.test(candidate.replace(/[*_`]/g, '')))
  if (!line) return DEFAULT_KEYS
  const text = line.toLowerCase()
  const keys: string[] = []
  const add = (key: string) => {
    if (!keys.includes(key)) keys.push(key)
  }
  if (/\barrow|\bleft\b|\bright\b|[←→]/.test(text)) {
    add('ArrowLeft')
    add('ArrowRight')
  }
  if (/\barrow|\bup\b|\bdown\b|[↑↓]/.test(text)) {
    add('ArrowUp')
    add('ArrowDown')
  }
  if (/wasd|\ba\s*[/|]\s*d\b/.test(text)) {
    add('a')
    add('d')
  }
  if (/wasd|\bw\s*[/|]\s*s\b/.test(text)) {
    add('w')
    add('s')
  }
  if (/space|jump|fire|shoot|thrust/.test(text)) add('Space')
  if (/enter|start/.test(text)) add('Enter')
  // Single letters called out as keys ("press P to pause", `k`).
  for (const match of text.matchAll(/(?:^|[^a-z])(?:key\s+|press\s+)?[`'"]?([a-z])[`'"]?\s*key/g)) {
    add(match[1])
  }
  return keys.length > 0 ? keys : DEFAULT_KEYS
}

// ── Playing ──────────────────────────────────────────────────────────────────

export type PlaySessionOptions = {
  gameDir: string
  /** Game-folder-relative page to open, from `game.json`. */
  entry: string
  /** Where the video and stills are written. */
  artifactsDir: string
  /** How long to play for, in seconds. */
  seconds: number
  /** Stills to take, spread evenly across the play. */
  frameCount: number
  keys: string[]
  headed: boolean
  /** The window the game is played in. Defaults to `DEFAULT_VIEWPORT`. */
  viewport?: Viewport
}

export type PlaySession = {
  entryUrl: string
  /** Straight after load: does the page run at all. */
  probeBefore: ProbeReport
  /** After playing: what moved. */
  probeAfter: ProbeReport
  consoleErrors: string[]
  keysPlayed: string[]
  videoPath: string | null
  framePaths: string[]
  viewport: { width: number; height: number }
  seconds: number
}

export type Viewport = { width: number; height: number }

/**
 * A browser window on a laptop, because Play opens a game in the user's default
 * browser (`shell.openPath`), not in a fixed-size app window.
 *
 * The size is part of the measurement, not a detail. The scaffold lays a level
 * out in fractions of the canvas while speeds stay in px/s, so a jump that
 * clears a gap in a short window cannot clear the same gap in a tall one: the
 * platformer in the 2026-08-14 set is winnable at 800x600 and unwinnable at
 * 1280x900, and a judge shown the short window calls a broken game fine.
 */
export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800 }

/** Probe the page exactly as `browser {"action":"probe"}` does. */
async function probe(page: Page): Promise<ProbeReport> {
  // PROBE_CALL is a function body (it returns), so it is wrapped the way the
  // browser tool wraps it before the page can evaluate it as an expression.
  const report = await page.evaluate<ProbeReport>(`(async () => {${PROBE_CALL}})()`)
  return report
}

const FIRST_FRAME_TIMEOUT_MS = 2000

/**
 * Wait for the page to paint once before the first probe. Headless Chromium
 * produces no animation frames for a moment after navigation, and probing into
 * that gap reports a perfectly good game as frozen and blank — which the score
 * gate would then take at face value. Waiting for the frame the probe is about
 * to count means "nothing is animating" means it.
 */
async function waitForFirstFrame(page: Page): Promise<void> {
  await page.evaluate(
    (timeout) =>
      new Promise<boolean>((resolve) => {
        const givenUp = setTimeout(() => resolve(false), timeout)
        requestAnimationFrame(() => {
          clearTimeout(givenUp)
          resolve(true)
        })
      }),
    FIRST_FRAME_TIMEOUT_MS,
  )
}

/** Playwright's name for a key the probe and `design.md` spell differently. */
function playwrightKey(key: string): string {
  if (key === ' ') return 'Space'
  return key
}

const STEERING_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'a',
  'd',
  'w',
  's',
])
const ADVANCING_KEYS = new Set(['ArrowRight', 'd'])

export type PlayPlan = {
  /** Held for a whole slice, so movement accumulates instead of cancelling out. */
  steer: string[]
  /** Tapped while steering — jump, fire, start. Empty in a game that only steers. */
  act: string[]
}

/**
 * Split the game's keys into one direction to hold and the rest to tap.
 *
 * Taking every key in turn spends a platformer's whole clip walking left, then
 * right, then left again, which ends where it started: the judge is shown a
 * character bouncing on the first ledge and reasonably concludes the harness
 * cannot play, when the interesting question was whether the jump clears the
 * ledge at all. Holding one direction while tapping the action key is the policy
 * that actually plays a platformer or a runner, and in a game with one button it
 * is what the old rotation did anyway.
 */
export function planPlay(keys: string[]): PlayPlan {
  const steer = keys.filter((key) => STEERING_KEYS.has(key))
  const act = keys.filter((key) => !STEERING_KEYS.has(key))
  // Rightwards first: a side-on game puts its goal there, and a game that does
  // not care is no worse off.
  steer.sort((left, right) => Number(ADVANCING_KEYS.has(right)) - Number(ADVANCING_KEYS.has(left)))
  return { steer, act }
}

async function playSlice(
  page: Page,
  plan: PlayPlan,
  slice: number,
  sliceMs: number,
  viewport: Viewport,
): Promise<void> {
  const startedAt = Date.now()
  const steer = plan.steer.length > 0 ? playwrightKey(plan.steer[slice % plan.steer.length]) : null
  const tap = plan.act.length > 0 ? playwrightKey(plan.act[slice % plan.act.length]) : null
  const held = Math.max(60, Math.floor(sliceMs * 0.35))

  if (steer) await page.keyboard.down(steer)
  try {
    for (let index = 0; index < 2; index += 1) {
      if (tap) {
        await page.keyboard.down(tap)
        await page.waitForTimeout(Math.min(120, held))
        await page.keyboard.up(tap)
      }
      await page.waitForTimeout(held)
    }
  } finally {
    if (steer) await page.keyboard.up(steer)
  }

  // Pointer games (aim, drag, tap-to-flap) never see a key. Sweeping the mouse
  // across the canvas and clicking costs nothing in a keyboard game and is the
  // whole input in a pointer one.
  const x = viewport.width * (0.25 + 0.5 * ((slice % 4) / 3))
  await page.mouse.move(x, viewport.height * 0.6)
  await page.mouse.click(x, viewport.height * 0.6)

  const remaining = sliceMs - (Date.now() - startedAt)
  if (remaining > 0) await page.waitForTimeout(remaining)
}

/**
 * Load the game, play it, and bring back everything the judge sees: the probe
 * before and after, the console, a video of the play and stills from it.
 *
 * Stills are taken alongside the video rather than cut out of it afterwards,
 * because that needs no decoder: providers disagree about which container they
 * accept, and a list of frames is the fallback that always works (Qwen documents
 * it as the other way to pass a video).
 */
export async function collectPlaySession(options: PlaySessionOptions): Promise<PlaySession> {
  const preview = await startPreviewServer(options.gameDir)
  const viewport = options.viewport ?? DEFAULT_VIEWPORT
  const videoDir = path.join(options.artifactsDir, 'video')
  const framesDir = path.join(options.artifactsDir, 'frames')
  fs.mkdirSync(framesDir, { recursive: true })

  let browser: Browser | null = null
  try {
    browser = await chromium.launch({ headless: !options.headed })
    const context = await browser.newContext({
      viewport,
      recordVideo: { dir: videoDir, size: viewport },
      // A game that reads the clock or the RNG is still allowed to; only the
      // window is pinned, so the recording is the size the judge is told it is.
      deviceScaleFactor: 1,
    })
    const page = await context.newPage()

    const consoleErrors: string[] = []
    page.on('pageerror', (error) => consoleErrors.push(`[uncaught] ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`[console] ${message.text()}`)
    })
    // `alert()` blocks the page and would hang the run instead of costing the
    // game a point, so it is dismissed and counted.
    page.on('dialog', (dialog) => {
      consoleErrors.push(`[dialog] ${dialog.type()}: ${dialog.message()}`)
      void dialog.dismiss().catch(() => undefined)
    })

    const entryUrl = new URL(options.entry.replace(/^\.?\//, ''), preview.baseUrl).toString()
    await page.goto(entryUrl, { waitUntil: 'load' })
    await waitForFirstFrame(page)
    const probeBefore = await probe(page)

    // Most games open on a title screen waiting for a click or a key. Doing this
    // before the clip starts in earnest means the video shows the game, not its
    // menu.
    await page.mouse.click(viewport.width / 2, viewport.height / 2)
    await page.keyboard.press('Enter')
    await page.keyboard.press('Space')

    const framePaths: string[] = []
    const plan = planPlay(options.keys)
    const sliceMs = (options.seconds * 1000) / options.frameCount
    for (let slice = 0; slice < options.frameCount; slice += 1) {
      await playSlice(page, plan, slice, sliceMs, viewport)
      const framePath = path.join(framesDir, `frame-${String(slice + 1).padStart(2, '0')}.png`)
      await page.screenshot({ path: framePath })
      framePaths.push(framePath)
    }

    const probeAfter = await probe(page)

    const video = page.video()
    await context.close()
    let videoPath: string | null = null
    if (video) {
      const recorded = await video.path()
      videoPath = path.join(options.artifactsDir, 'play.webm')
      fs.renameSync(recorded, videoPath)
      fs.rmSync(videoDir, { recursive: true, force: true })
    }

    return {
      entryUrl,
      probeBefore,
      probeAfter,
      consoleErrors,
      keysPlayed: options.keys,
      videoPath,
      framePaths,
      viewport,
      seconds: options.seconds,
    }
  } finally {
    await browser?.close().catch(() => undefined)
    await preview.close()
  }
}
