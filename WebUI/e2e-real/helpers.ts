import { type ElectronApplication, type Page } from '@playwright/test'

/**
 * Finds the main renderer window among Electron's windows.
 *
 * Instead of relying on URL checks (which can be unreliable with DevTools),
 * this helper simply gets the first window and waits for app content to appear.
 * If the first window is DevTools, it waits for the next window with a Vite URL.
 */
export async function getMainWindow(electronApp: ElectronApplication): Promise<Page> {
  // Wait up to 30s for windows to appear, then pick the right one
  const start = Date.now()
  const TIMEOUT = 30_000

  while (Date.now() - start < TIMEOUT) {
    const windows = electronApp.windows()

    for (const w of windows) {
      const url = w.url()
      // The main app window loads from the Vite dev server
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        return w
      }
    }

    // If only one window exists and it has about:blank, wait for navigation
    if (windows.length === 1 && windows[0].url() === 'about:blank') {
      try {
        await windows[0].waitForURL(/http:\/\/127\.0\.0\.1/, { timeout: 5000 })
        return windows[0]
      } catch {
        // Keep trying
      }
    }

    await new Promise((r) => setTimeout(r, 500))
  }

  // Fallback: just return the first window and hope for the best
  const windows = electronApp.windows()
  if (windows.length > 0) {
    return windows[0]
  }

  throw new Error('No windows found after 30s')
}
