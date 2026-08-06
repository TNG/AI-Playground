// Real-browser driver for the Home Agent "LAN chat" served page. Where
// localWebClient.ts *reimplements* a browser over raw http/SSE (exercising only
// the Python transport), this loads the served page in an actual browser and
// drives its own JavaScript — the login form, the `EventSource('/api/events')`
// subscription, the `#send` handler POSTing `/api/chat`, and the reply
// rendering. That is the "I typed something in the browser and nothing happened"
// surface, which the raw client can't cover because it never loads the page.
//
// We open the page in a fresh Electron BrowserWindow of the app under test
// rather than a separately-launched Chromium: the e2e suite only ever installs
// the Electron binary (never `npx playwright install`), so `chromium.launch()`
// isn't available — but the running app's Chromium loads the plain HTTP page
// exactly as a user's browser would (fetch + EventSource + same-origin cookies).

import { type ElectronApplication, type Page, expect } from '@playwright/test'

/** Open the served page in a new BrowserWindow and sign in through the real DOM.
 *  Resolves with the window's Page once the chat screen is up and the SSE stream
 *  reports connected. */
export async function openLocalWebChat(
  electronApp: ElectronApplication,
  baseUrl: string,
  password: string,
): Promise<Page> {
  const pagePromise = electronApp.waitForEvent('window')
  await electronApp.evaluate(async ({ BrowserWindow }, url) => {
    const win = new BrowserWindow({
      width: 480,
      height: 820,
      // Keep timers/EventSource running even if the window isn't focused, so the
      // SSE reply isn't throttled while the test drives the main window.
      webPreferences: { backgroundThrottling: false },
    })
    await win.loadURL(url)
  }, baseUrl)

  const page = await pagePromise
  page.on('pageerror', (err) => console.error(`[local-web page:error] ${err.message}`))

  // Login screen → type the password and sign in via the page's own handler.
  await expect(page.locator('#login-screen')).toBeVisible({ timeout: 15_000 })
  await page.locator('#password').fill(password)
  await page.locator('#login-btn').click()

  // A successful login swaps to the chat screen and opens the SSE stream, which
  // posts the "Connected" system line. Failure here means the page JS never
  // established the session/stream — exactly the silent break we're guarding.
  await expect(page.locator('#chat-screen')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Connected', { exact: false })).toBeVisible({ timeout: 15_000 })
  return page
}

/**
 * Type a message into the composer, click send, and resolve with the settled
 * bot reply text. Auto-taps an interactive keyboard prompt (e.g. a model-
 * download approval renders as `.kbd-row button`s) so a turn that needs one
 * still completes — the DOM analogue of localWebClient's callback auto-confirm.
 * A settled reply is a bot bubble that is neither the streaming draft nor the
 * typing-dots placeholder.
 */
export async function sendAndAwaitReply(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<string> {
  // Auto-confirm any in-channel prompt that appears mid-turn.
  await page.addLocatorHandler(page.locator('.kbd-row button').first(), async (btn) => {
    await btn.click()
  })

  await page.locator('#input').fill(text)
  await page.locator('#send').click()

  const settledReply = page
    .locator('.row-bot .bubble:not(.streaming)')
    .filter({ hasNot: page.locator('.typing-dots') })
  await expect(settledReply.last()).toHaveText(/\S/, { timeout: timeoutMs })
  return ((await settledReply.last().innerText()) ?? '').trim()
}
