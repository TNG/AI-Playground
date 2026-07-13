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

export async function launchElectronApp(): Promise<ElectronApplication> {
  const mainPath = resolveMainEntry()
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
    await use(window)
  },

  app: async ({ window }, use) => {
    await use(new AppDriver(window))
  },
})

export { expect } from '@playwright/test'
