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

export const VITE_PORT = 25413
export const VITE_URL = `http://127.0.0.1:${VITE_PORT}`
export const WEBUI_DIR = path.resolve(__dirname, '..')

function ensureMainProcessCompiled(): void {
  const mainJs = path.join(WEBUI_DIR, 'dist', 'main', 'main.js')
  const preloadJs = path.join(WEBUI_DIR, 'dist', 'preload', 'preload.js')
  if (fs.existsSync(mainJs) && fs.existsSync(preloadJs)) {
    return
  }
  console.log('[e2e] Compiling Electron main + preload via Vite...')
  execSync('npx vite build --mode development 2>&1 || true', {
    cwd: WEBUI_DIR,
    timeout: 120_000,
  })
}

export async function launchElectronApp(): Promise<ElectronApplication> {
  ensureMainProcessCompiled()

  const mainPath = path.join(WEBUI_DIR, 'dist', 'main', 'main.js')

  const app = await electron.launch({
    args: [mainPath],
    cwd: WEBUI_DIR,
    env: {
      ...process.env,
      DISPLAY: process.env.DISPLAY || ':1',
      VITE_DEV_SERVER_URL: VITE_URL,
      VITE_DEBUG_TOOLS: 'true',
      VITE_PLATFORM_TITLE: 'from Intel®',
      DIST: path.join(WEBUI_DIR, 'dist'),
      VITE_PUBLIC: path.join(WEBUI_DIR, 'public'),
      NODE_ENV: 'development',
      AIPG_E2E_TEST: 'true',
    },
    timeout: 60_000,
  })

  // Close auto-opened DevTools to avoid window-selection issues
  await app.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools()
      }
    }
  })

  return app
}

type E2EFixtures = {
  electronApp: ElectronApplication
  window: Page
}

export const test = base.extend<E2EFixtures>({
  electronApp: async ({}, use) => {
    const app = await launchElectronApp()
    await use(app)
    await app.close()
  },

  window: async ({ electronApp }, use) => {
    const mainPage = await getMainWindow(electronApp)

    mainPage.on('console', (msg) => {
      if (process.env.E2E_VERBOSE) {
        console.log(`[renderer:${msg.type()}] ${msg.text()}`)
      }
    })
    mainPage.on('pageerror', (err) => {
      console.error(`[renderer:error] ${err.message}`)
    })
    await use(mainPage)
  },
})

export { expect } from '@playwright/test'
