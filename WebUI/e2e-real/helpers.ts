import { type ElectronApplication, type Page } from '@playwright/test'

/**
 * Finds the main renderer window among Electron's windows.
 *
 * Strategy: get the first window, check if it's the app window (URL starts
 * with http://). If not (it's DevTools), wait for the next window event.
 */
export async function getMainWindow(electronApp: ElectronApplication): Promise<Page> {
  // Get the first window that opens
  const firstPage = await electronApp.firstWindow({ timeout: 30_000 })
  const firstUrl = firstPage.url()

  if (firstUrl.startsWith('http://127.0.0.1') || firstUrl.startsWith('http://localhost')) {
    await firstPage.waitForLoadState('domcontentloaded')
    return firstPage
  }

  // First window was DevTools or about:blank — wait for the next one
  console.log(`[e2e] First window URL: ${firstUrl} — waiting for app window...`)

  return new Promise<Page>((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Check one more time — maybe a window navigated
      for (const w of electronApp.windows()) {
        const url = w.url()
        if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
          resolve(w)
          return
        }
      }
      reject(
        new Error(
          `Timed out. URLs: ${electronApp
            .windows()
            .map((w) => w.url())
            .join(', ')}`,
        ),
      )
    }, 30_000)

    const handler = (page: Page) => {
      const checkUrl = () => {
        const url = page.url()
        if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
          clearTimeout(timeout)
          page.waitForLoadState('domcontentloaded').then(() => resolve(page))
        }
      }
      checkUrl()
      page.on('framenavigated', checkUrl)
    }

    electronApp.on('window', handler)

    // Also re-check existing windows (one might have navigated)
    for (const w of electronApp.windows()) {
      handler(w)
    }
  })
}
