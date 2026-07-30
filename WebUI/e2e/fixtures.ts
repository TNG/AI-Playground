import {
  test as base,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { execSync } from 'child_process'
import path from 'path'
import fs from 'fs'
import { getMainWindow } from './helpers'
import { AppDriver } from './appDriver'

export const VITE_PORT = 25413
export const VITE_URL = `http://127.0.0.1:${VITE_PORT}`
export const WEBUI_DIR = path.resolve(__dirname, '..')

/**
 * Locate the compiled Electron main entry. `npm run dev` (Vite serve mode) emits
 * it under `dist/main`; a `vite build` emits it under `../build/dist/main`. The
 * preload is always a sibling (`../preload/preload.js`, see electron/main.ts), so
 * either layout works as long as we hand Electron the matching main.js.
 */
function resolveMainEntry(): string {
  const candidates = [
    path.join(WEBUI_DIR, 'dist', 'main', 'main.js'),
    path.join(WEBUI_DIR, '..', 'build', 'dist', 'main', 'main.js'),
  ]
  for (const c of candidates) {
    if (
      fs.existsSync(c) &&
      fs.existsSync(path.join(path.dirname(c), '..', 'preload', 'preload.js'))
    ) {
      return c
    }
  }

  // Nothing compiled yet — build main + preload (renderer is served by Vite).
  console.log('[e2e] Electron main/preload not found — running `vite build --mode development`...')
  execSync('npx vite build --mode development', {
    cwd: WEBUI_DIR,
    stdio: 'inherit',
    timeout: 300_000,
  })

  const built = path.join(WEBUI_DIR, '..', 'build', 'dist', 'main', 'main.js')
  if (!fs.existsSync(built)) {
    throw new Error(
      `[e2e] Could not find a compiled Electron main entry after build (looked at ${built})`,
    )
  }
  return built
}

/** Best-effort removal of a stale Electron single-instance lock (POSIX only). */
function cleanupSingletonLock(): void {
  if (process.platform === 'win32') return // Windows uses a named mutex freed on exit
  const home = process.env.HOME || ''
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(home, '.config', 'ai-playground', name))
    } catch {
      // not present
    }
  }
}

async function launchOnce(mainPath: string): Promise<ElectronApplication> {
  cleanupSingletonLock()
  return electron.launch({
    args: [mainPath],
    cwd: WEBUI_DIR,
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: VITE_URL,
      VITE_DEBUG_TOOLS: 'true',
      VITE_PLATFORM_TITLE: 'from Intel®',
      NODE_ENV: 'development',
      ...(process.platform === 'linux' ? { DISPLAY: process.env.DISPLAY || ':0' } : {}),
    },
    timeout: 60_000,
  })
}

export async function launchElectronApp(): Promise<ElectronApplication> {
  const mainPath = resolveMainEntry()

  // Launch, then confirm the renderer window actually appears. A previous test's
  // Electron (or its backend subprocesses) not being fully reaped can make the new
  // instance hit the single-instance guard and quit with no window — especially on
  // Windows, where the guard is a named mutex we can't clear from disk. That surfaces
  // as "No Electron windows appeared within 30s". Rather than fail the test on this
  // harness-level flake, tear the dud down and relaunch once.
  const MAX_ATTEMPTS = 2
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const app = await launchOnce(mainPath)
    try {
      await getMainWindow(app)
      return app
    } catch (error) {
      lastError = error
      await app.close().catch(() => {})
      if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 3_000))
    }
  }
  throw lastError
}

type E2EFixtures = {
  electronApp: ElectronApplication
  window: Page
  /** High-level driver. `await app.installAllBackends()` is the start of every test. */
  app: AppDriver
}

export const test = base.extend<E2EFixtures>({
  electronApp: async ({}, use) => {
    const app = await launchElectronApp()
    await use(app)
    await app.close()
  },

  window: async ({ electronApp }, use) => {
    const window = await getMainWindow(electronApp)
    window.on('pageerror', (err) => console.error(`[renderer:error] ${err.message}`))
    if (process.env.E2E_VERBOSE) {
      window.on('console', (msg) => console.log(`[renderer:${msg.type()}] ${msg.text()}`))
    }

    // The high-memory / video-VRAM warning is an *optional* popup: it fires whenever a
    // gated preset becomes active — including when merely switching to a mode whose
    // last-used preset is gated — so it can appear before any step we control and its
    // backdrop then intercepts clicks. Auto-dismiss it wherever it shows up: tick
    // "Do not show again" (suppresses future prompts for that preset) and Confirm (which
    // proceeds with the switch). Scoped by message so it never touches other warnings.
    const memoryWarning = window
      .getByRole('dialog', { name: 'Warning' })
      .filter({ hasText: /high memory use|discrete GPUs with 16GB/i })
    await window.addLocatorHandler(memoryWarning, async (dialog) => {
      const dontShowAgain = dialog.getByRole('checkbox')
      if (await dontShowAgain.isVisible().catch(() => false)) await dontShowAgain.click()
      await dialog.getByRole('button', { name: 'Confirm', exact: true }).click()
    })

    await use(window)
  },

  app: async ({ window }, use) => {
    await use(new AppDriver(window))
  },
})

export { expect } from '@playwright/test'
