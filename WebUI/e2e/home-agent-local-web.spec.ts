import { test, expect } from './fixtures'
import { MainPage } from './pages/MainPage'
import { HomeAgentPage } from './pages/HomeAgentPage'
import { login, sendChat, waitForReply } from './localWebClient'
import {
  openLocalWebChat,
  sendAndAwaitReply,
  sendAndAwaitText,
  sendMessage,
  userMessages,
} from './localWebBrowser'

// Full round-trip for the Home Agent "local web chat" channel — the third option
// alongside Telegram and Slack, but served by the Python backend (no cloud relay,
// no extra Electron server). This is the local-web analogue of the agentic "lizard"
// smoke: install → set the channel up in the UI → then drive it end to end from a
// *browser's* perspective (raw HTTP + SSE against the served chat page), asking the
// Home Agent to write a haiku about a lizard and asserting a real reply streams back.
//
// Unlike the desktop-chat smoke, inference here flows through the Home Agent's own
// bundled preset + model. If that model isn't present yet the agent asks to download
// it *in-channel*; the SSE client auto-confirms that prompt (see localWebClient.ts),
// so a first run still completes — it just takes as long as the download.

// A local port unlikely to collide with a real user's default (8765), and a throwaway
// password. Bound to 127.0.0.1 (allowLan off) — the test client connects on loopback.
const LOCAL_WEB_PORT = 8770
const LOCAL_WEB_PASSWORD = 'lizard-e2e-pw'
const BASE_URL = `http://127.0.0.1:${LOCAL_WEB_PORT}`

const PROMPT = 'Write a haiku about a friendly, goofy surfer-dude lizard.'

test.describe('Home Agent — local web chat', () => {
  test('serves a browser chat and answers a haiku over SSE', async ({
    app,
    window,
    electronApp,
  }) => {
    // Install + Home-Agent bring-up + a real (possibly first-time) model turn all
    // exceed the default timeout — match the agentic smoke's budget.
    test.setTimeout(30 * 60_000)

    await app.installAllBackends()

    const homeAgentAvailable = await app.ensureHomeAgentBackendInstalled()
    test.skip(!homeAgentAvailable, 'Home Agent backend is not available in this product mode')

    const homeAgent = new HomeAgentPage(window)

    await test.step('Set up the local web chat channel and turn the agent on', async () => {
      await homeAgent.open()
      await homeAgent.configureLocalWeb({ port: LOCAL_WEB_PORT, password: LOCAL_WEB_PASSWORD })
      await homeAgent.finishSetup()
      await homeAgent.ensureMasterOn()
    })

    await test.step('Sign in to the served chat page as a LAN browser would', async () => {
      // The Python channel serves the login/chat page and mints a session cookie —
      // failing here means the server never bound (config → set_config → listen).
      const cookie = await login(BASE_URL, LOCAL_WEB_PASSWORD)
      expect(cookie).toContain('aipg_local_web=')

      await test.step('Ask for a lizard haiku → expect a streamed reply', async () => {
        // Open the SSE stream first so we don't miss the reply, then post the prompt.
        const stream = waitForReply(BASE_URL, cookie, MainPage.IMAGE_TIMEOUT)
        await sendChat(BASE_URL, cookie, { text: PROMPT })
        const reply = await stream.done
        expect(reply.trim()).not.toEqual('')
      })
    })

    // The raw-http round-trip above proves the Python transport + the renderer
    // bridge, but never loads the served page — so a break in the page's own JS
    // (send handler, EventSource wiring, reply rendering) would go unnoticed
    // while a user sees "I typed something and nothing happened". Drive the real
    // page in an actual browser to close that gap. The model is warm from the
    // turn above, so this second turn is fast and needs no download prompt.
    await test.step('Drive the real served page in a browser end to end', async () => {
      const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
      try {
        const reply = await sendAndAwaitReply(page, PROMPT, MainPage.IMAGE_TIMEOUT)
        expect(reply).not.toEqual('')
      } finally {
        await page.close()
      }
    })

    // The LAN page keeps no history of its own, so both /new and /load have to
    // repaint it: /new with a clean slate, /load with the chosen thread's
    // transcript. Put a distinct codeword in each of two threads, then switch
    // between them and assert only the active thread's codeword is on screen.
    await test.step('/new and /load switch and repaint chat threads', async () => {
      const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
      try {
        // Baseline /new burns any pre-existing empty thread so the /new below is
        // guaranteed to create the newest thread (index 1 for /load).
        await sendAndAwaitText(page, '/new', 'new chat thread', 60_000)
        await sendAndAwaitReply(page, 'Remember the codeword MARCO.', MainPage.IMAGE_TIMEOUT)

        await sendAndAwaitText(page, '/new', 'new chat thread', 60_000)
        await sendAndAwaitReply(page, 'Remember the codeword POLO.', MainPage.IMAGE_TIMEOUT)

        // POLO is in the current thread; MARCO belongs to the one before it, and
        // /new repaints the page, so only POLO is on screen now.
        const marco = userMessages(page, 'MARCO')
        const polo = userMessages(page, 'POLO')
        await expect(marco).toHaveCount(0)
        await expect(polo).toHaveCount(1)

        // Loading the MARCO thread repaints from its transcript, so the two swap.
        await sendMessage(page, '/load 2')
        await expect(marco).toHaveCount(1, { timeout: 60_000 })
        await expect(polo).toHaveCount(0)

        // …and back again, proving the repaint follows whichever thread is active
        // rather than only ever growing.
        await sendMessage(page, '/load 1')
        await expect(polo).toHaveCount(1, { timeout: 60_000 })
        await expect(marco).toHaveCount(0)
      } finally {
        await page.close()
      }
    })
  })
})
