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
  await signInAndAwaitChat(page, password)
  return page
}

/**
 * Sign in (when the login form is showing) and wait until the chat screen is live,
 * then arm the prompt auto-confirm handler. Split from `openLocalWebChat` so the
 * page can also be driven without standing up the whole Electron app.
 */
export async function signInAndAwaitChat(page: Page, password: string): Promise<void> {
  // The page settles on one of two screens: the login form (fresh) or straight
  // to chat when a prior window's session cookie still authenticates (Electron
  // BrowserWindows share the default session). Both screens are always in the
  // DOM (one is hidden), so wait for whichever became visible — a locator
  // matching both would be a strict-mode violation.
  const passwordField = page.getByLabel('Password')
  await expect
    .poll(async () => (await passwordField.isVisible()) || (await composer(page).isVisible()), {
      timeout: 15_000,
    })
    .toBe(true)

  // Only sign in when the login form is actually showing.
  if (await passwordField.isVisible()) {
    await passwordField.fill(password)
    await page.getByRole('button', { name: 'Sign in' }).click()
  }

  // A live session swaps to the chat screen and opens the SSE stream, which posts
  // the "Connected" system line. Failure here means the page JS never
  // established the session/stream — exactly the silent break we're guarding.
  await expect(composer(page)).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Connected', { exact: false })).toBeVisible({ timeout: 15_000 })

  // Auto-confirm any in-channel prompt that appears mid-turn (e.g. a model-
  // download approval renders as a button group) so a turn that needs one still
  // completes — the DOM analogue of localWebClient's callback auto-confirm.
  // Registered once per page rather than per send so handlers don't stack. The
  // page retires a prompt's buttons once tapped, which is also what lets
  // Playwright's post-handler "overlay is gone" check pass.
  await page.addLocatorHandler(promptButtons(page).first(), async (btn) => {
    await btn.click()
  })
}

const composer = (page: Page) => page.getByRole('textbox', { name: 'Message' })

/** Buttons of any interactive prompt still awaiting an answer. */
const promptButtons = (page: Page) =>
  page.getByRole('group', { name: 'Choose an option' }).getByRole('button')

/** Settled bot replies. The in-flight draft and the typing placeholder carry
 *  different accessible names, so this counts only finished messages. */
function settledBotBubbles(page: Page) {
  return page.getByRole('article', { name: 'Home Agent response', exact: true })
}

/** Messages the user sent, optionally filtered to those containing `text`. */
export function userMessages(page: Page, text?: string) {
  const messages = page.getByRole('article', { name: 'Your message', exact: true })
  return text ? messages.filter({ hasText: text }) : messages
}

/** Type into the composer and click send. Fire-and-forget: the caller decides
 *  what to await (a reply, a repaint, a specific bubble). */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await composer(page).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
}

/**
 * Send a message/command and resolve once a *new* settled bot reply appears
 * (counting bubbles so it works across many turns, not just the first). Any
 * mid-turn keyboard prompt is auto-confirmed by the handler registered in
 * openLocalWebChat.
 *
 * Only for turns that leave the log intact: a command that repaints the page
 * (`/new`, `/load`) resets the count, so use {@link sendAndAwaitText} there.
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

/**
 * Send a message/command and resolve once a settled reply containing `expected`
 * is on screen. Counting bubbles cannot work for the commands that repaint the
 * log from a conversation transcript, because the repaint drops the earlier
 * replies — so match the reply itself instead.
 */
export async function sendAndAwaitText(
  page: Page,
  text: string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  await sendMessage(page, text)
  await expect(settledBotBubbles(page).filter({ hasText: expected })).toHaveCount(1, {
    timeout: timeoutMs,
  })
}
