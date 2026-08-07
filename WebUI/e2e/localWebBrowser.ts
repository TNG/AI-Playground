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

  // The page settles on one of two screens: the login form (fresh) or straight
  // to chat when a prior window's session cookie still authenticates (Electron
  // BrowserWindows share the default session). Both <div>s always exist (one
  // carries `.hidden`), so match only the visible one via `:not(.hidden)`.
  await expect(page.locator('#login-screen:not(.hidden), #chat-screen:not(.hidden)')).toBeVisible({
    timeout: 15_000,
  })

  // Only sign in when the login form is actually showing.
  if (await page.locator('#login-screen').isVisible()) {
    await page.locator('#password').fill(password)
    await page.locator('#login-btn').click()
  }

  // A live session swaps to the chat screen and opens the SSE stream, which posts
  // the "Connected" system line. Failure here means the page JS never
  // established the session/stream — exactly the silent break we're guarding.
  await expect(page.locator('#chat-screen')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Connected', { exact: false })).toBeVisible({ timeout: 15_000 })

  // Auto-confirm any in-channel prompt that appears mid-turn (e.g. a model-
  // download approval renders as `.kbd-row button`s) so a turn that needs one
  // still completes — the DOM analogue of localWebClient's callback auto-confirm.
  // Registered once per page rather than per send so handlers don't stack.
  await page.addLocatorHandler(page.locator('.kbd-row button').first(), async (btn) => {
    await btn.click()
  })
  return page
}

/** Settled bot bubbles — final replies, excluding the streaming draft and the
 *  typing-dots placeholder. */
function settledBotBubbles(page: Page) {
  return page
    .locator('.row-bot .bubble:not(.streaming)')
    .filter({ hasNot: page.locator('.typing-dots') })
}

/** Type into the composer and click send. Fire-and-forget: the caller decides
 *  what to await (a reply, a repaint, a specific bubble). */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await page.locator('#input').fill(text)
  await page.locator('#send').click()
}

/**
 * Send a message/command and resolve once a *new* settled bot reply appears
 * (counting bubbles so it works across many turns, not just the first). Any
 * mid-turn keyboard prompt is auto-confirmed by the handler registered in
 * openLocalWebChat.
 */
export async function sendAndAwaitReply(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<string> {
  const settled = settledBotBubbles(page)
  const before = await settled.count()
  await sendMessage(page, text)
  await expect.poll(() => settled.count(), { timeout: timeoutMs }).toBeGreaterThan(before)
  return ((await settled.last().innerText()) ?? '').trim()
}
