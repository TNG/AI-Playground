import { type ElectronApplication, type Page } from '@playwright/test'

/**
 * Finds the main renderer window among Electron's windows.
 *
 * Closes any auto-opened DevTools first, then waits for the app window
 * (URL starting with http://127.0.0.1 or http://localhost).
 */
export async function getMainWindow(electronApp: ElectronApplication): Promise<Page> {
  // Close any DevTools windows that were auto-opened in dev mode
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools()
      }
    }
  })

  // Small delay for DevTools windows to close and main window to navigate
  await new Promise((r) => setTimeout(r, 1000))

  // Now find the app window
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    for (const w of electronApp.windows()) {
      const url = w.url()
      if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
        await w.waitForLoadState('domcontentloaded')
        return w
      }
    }

    // Wait for new windows or poll
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000)
      electronApp.once('window', () => {
        clearTimeout(timer)
        setTimeout(resolve, 500)
      })
    })
  }

  const urls = electronApp.windows().map((w) => w.url())
  throw new Error(`Main window not found after 60s. Window URLs: ${JSON.stringify(urls)}`)
}
