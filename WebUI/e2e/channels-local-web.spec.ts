import { test, expect } from './fixtures'
import type { AppDriver } from './appDriver'
import type { Page } from '@playwright/test'
import { MainPage } from './pages/MainPage'
import { ChannelsPage } from './pages/ChannelsPage'
import {
  agentMessages,
  agentRepliesTo,
  answerAgentMessage,
  draftBubbles,
  openLocalWebChat,
  sendAndAwaitMedia,
  sendAndAwaitSessionReply,
  sendAndAwaitText,
  sendMessage,
  settledBotBubbles,
  lanImages,
  lanVideos,
  userMessages,
} from './localWebBrowser'

// End-to-end coverage for the "LAN chat" Channel — the browser-served,
// loopback/LAN-reachable third option alongside Telegram and Slack, served by the
// Python backend (no cloud relay, no extra Electron server). Every test installs
// the backends, brings the channel up, then drives the *real served page* in an
// actual browser (raw HTTP + SSE against the served chat page). A plain message runs
// as an Assistant turn in the channel's Channel Session; if a model isn't present yet
// it is asked for in-channel, and the served page's auto-confirm handler (see
// localWebBrowser.ts) taps "Confirm" so a first run still completes.

// A local port unlikely to collide with a real user's default (8765), and a throwaway
// password. Bound to 127.0.0.1 (allowLan off) — the test connects on loopback.
const LOCAL_WEB_PORT = 8770
const LOCAL_WEB_PASSWORD = 'lizard-e2e-pw'
const BASE_URL = `http://127.0.0.1:${LOCAL_WEB_PORT}`

// An agentic prompt — the assistant decides how to answer. Deliberately a plain
// creative ask (no slash command) so it exercises a real inference turn.
const HAIKU_PROMPT = 'Write a haiku about a friendly, goofy surfer-dude lizard.'

// Per-Session markers for the repaint test. Neutral small-talk that just happens to
// carry a unique token, so Assistant reads it as chit-chat rather than a task. The token
// lives in the *user* message, which is what `/load` repaints verbatim from the
// transcript.
const MARKER_MARCO = 'Quick question for fun — what is a nice thing about the ocean? Tag: MARCO'
const MARKER_POLO = 'Quick question for fun — what is a nice thing about the sun? Tag: POLO'

// The lizard image → edit → video flow, mirroring the desktop full-flow prompts.
const MEDIA_PROMPTS = {
  generateImage:
    'Generate an image of a lizard character, he is muscular fun and friendly and designed for an animated film. He is a surfer dude, and with a goofy but friendly vibe. Generate in 1:1 aspect ratio',
  editImage: 'Edit this image giving this character sunglasses and classic surfer hair',
  animateToVideo:
    'Lets bring this image to life. Animate this using LTX.2.3 i2v image to video. Have him waving hi and saying Hey Dudes, then jumping back into a cool pose that is consistent with his surfer, goofy character',
}

// A turn long enough to still be running when the next message arrives, and that message.
const LONG_PROMPT =
  'Write a detailed 1500-word short story about a lighthouse keeper who befriends a seagull.'
const QUEUED_PROMPT = 'Also give the story a title.'

// An agent session that pings the LAN chat, then the Answer that continues it.
const NOTIFY_PROMPT =
  'Send me a notification with notify_user that says exactly "Ready for your answer", then stop.'
const NOTIFICATION_TEXT = 'Ready for your answer'
const ANSWER_TEXT = 'Reply with the single word PINEAPPLE.'

// Two replies at once, each asked for a word of its own.
const MANGO = 'Reply with the single word MANGO.'
const PAPAYA = 'Reply with the single word PAPAYA.'

/**
 * Install backends, ensure the channels backend is present (skipping when it isn't
 * offered in this product mode), then set up + start the LAN chat channel and turn the
 * master switch on. Each test launches a fresh app (the electronApp fixture is
 * per-test), so this runs once per test — install is idempotent and the channel config
 * persists across runs.
 */
async function bringUpLanChat(app: AppDriver, window: Page): Promise<void> {
  await app.installAllBackends()

  const channelsAvailable = await app.ensureChannelsBackendInstalled()
  test.skip(!channelsAvailable, 'The Channels backend is not available in this product mode')

  const channelSetup = new ChannelsPage(window)
  await test.step('Set up the local web chat channel and turn the agent on', async () => {
    await channelSetup.open()
    await channelSetup.configureLocalWeb({ port: LOCAL_WEB_PORT, password: LOCAL_WEB_PASSWORD })
    await channelSetup.finishSetup()
    await channelSetup.ensureMasterOn()
  })
}

test.describe('Channels — local web chat', () => {
  test('drives the served chat page end to end', async ({ app, window, electronApp }) => {
    // Install + Channels bring-up + a real (possibly first-time) model turn all
    // exceed the default timeout — match the agentic smoke's budget.
    test.setTimeout(30 * 60_000)
    await bringUpLanChat(app, window)

    // The raw transport plus the served page's own JS (login form, EventSource
    // wiring, send handler, reply rendering) — the "I typed something and nothing
    // happened" surface. A plain message runs in the Channel Session, and its reply is
    // threaded under it; the desktop stays on the Session it had open.
    const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
    try {
      const reply = await sendAndAwaitSessionReply(page, HAIKU_PROMPT, MainPage.IMAGE_TIMEOUT)
      expect(reply).not.toEqual('')
      await expect(window.getByText(HAIKU_PROMPT)).toHaveCount(0)
    } finally {
      await page.close()
    }
  })

  test('/new, /sessions and /load pick the Channel Session and repaint it', async ({
    app,
    window,
    electronApp,
  }) => {
    test.setTimeout(30 * 60_000)
    await bringUpLanChat(app, window)

    // The LAN page keeps no history of its own, so /new and /load repaint it: /new
    // with a clean slate, /load with the chosen Session's transcript. Each /new makes
    // a Reachable Session, so the two marker Sessions are the newest two in /sessions.
    const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
    try {
      await test.step('Two new Sessions, each with its own marker', async () => {
        await sendAndAwaitText(page, '/new', 'Started a new Session', 60_000)
        await expect(userMessages(page)).toHaveCount(0)
        await sendAndAwaitSessionReply(page, MARKER_MARCO, MainPage.TEXT_TIMEOUT)

        await sendAndAwaitText(page, '/new', 'Started a new Session', 60_000)
        await expect(userMessages(page)).toHaveCount(0)
        await sendAndAwaitSessionReply(page, MARKER_POLO, MainPage.TEXT_TIMEOUT)
      })

      const marco = userMessages(page, 'MARCO')
      const polo = userMessages(page, 'POLO')

      await test.step('/load 2 repaints the older Session', async () => {
        await sendMessage(page, '/load 2')
        await expect(marco).toHaveCount(1, { timeout: 60_000 })
        await expect(polo).toHaveCount(0)
      })

      await test.step('/sessions lists them newest first; a tap loads one', async () => {
        // The auto-confirm handler taps the first button of the list, the newest Session.
        await sendMessage(page, '/sessions')
        await expect(polo).toHaveCount(1, { timeout: 60_000 })
        await expect(marco).toHaveCount(0)
      })

      await test.step('The next plain message continues the loaded Session', async () => {
        await sendAndAwaitSessionReply(page, 'And one word for it?', MainPage.TEXT_TIMEOUT)
        await sendMessage(page, '/load 1')
        await expect(polo).toHaveCount(1, { timeout: 60_000 })
        await expect(userMessages(page, 'And one word for it?')).toHaveCount(1)
      })
    } finally {
      await page.close()
    }
  })

  test('queues a message sent while the turn runs, and /stop calls both off', async ({
    app,
    window,
    electronApp,
  }) => {
    test.setTimeout(30 * 60_000)
    await bringUpLanChat(app, window)

    const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
    try {
      await sendAndAwaitText(page, '/new', 'Started a new Session', 60_000)

      await test.step('A message sent during the turn is queued with its place', async () => {
        await sendMessage(page, LONG_PROMPT)
        await sendAndAwaitText(page, QUEUED_PROMPT, 'Queued (1st)', MainPage.TEXT_TIMEOUT)
      })

      await test.step('/stop stops the turn and drops the queued message', async () => {
        await sendAndAwaitText(page, '/stop', 'Queued messages dropped: 1.', 60_000)
        await expect(settledBotBubbles(page).filter({ hasText: 'Stopped the turn' })).toHaveCount(1)
      })

      await test.step('Nothing is left running afterwards', async () => {
        await sendAndAwaitText(page, '/stop', 'Nothing is running', 60_000)
        await expect(agentRepliesTo(page, QUEUED_PROMPT)).toHaveCount(0)
      })
    } finally {
      await page.close()
    }
  })

  test('answers an agent Notification from the LAN page', async ({ app, window, electronApp }) => {
    // Install + Channels bring-up + the Agent preset's own model + two agent turns.
    test.setTimeout(45 * 60_000)
    await bringUpLanChat(app, window)

    const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
    try {
      await test.step('Open a new Session and make it reachable from Channels', async () => {
        await app.shell.ensureSettingsClosed()
        await app.shell.startNewSession()
        await app.shell.makeOpenSessionReachable()
      })

      const ready = await app.prepareAgentPreset()
      test.skip(!ready, 'Preset "Agent" is not available in this product mode')

      await test.step('An agent session sends a Notification to the LAN page', async () => {
        await app.runAgentTurn(NOTIFY_PROMPT, MainPage.TEXT_TIMEOUT)
        await expect(agentMessages(page, NOTIFICATION_TEXT).first()).toBeVisible({
          timeout: 60_000,
        })
      })

      await test.step('A command typed while answering still runs as a command', async () => {
        const target = page.getByRole('status', { name: 'Answer target' })
        const notification = agentMessages(page, NOTIFICATION_TEXT).first()
        await notification.getByRole('button', { name: 'Answer' }).click()
        await expect(target).toContainText('Replying to')
        await sendAndAwaitText(page, '/help', 'To answer an agent', 60_000)
        await expect(target).toBeVisible()
      })

      await test.step('Answer it → the agent replies under the Answer', async () => {
        await answerAgentMessage(page, agentMessages(page, NOTIFICATION_TEXT).first(), ANSWER_TEXT)
        await expect(userMessages(page, ANSWER_TEXT)).toHaveCount(1)
        await expect(agentRepliesTo(page, ANSWER_TEXT).first()).toBeVisible({
          timeout: MainPage.TEXT_TIMEOUT,
        })
      })
    } finally {
      await page.close()
    }
  })

  test('two Sessions replying at once stream into separate bubbles', async ({
    app,
    window,
    electronApp,
  }) => {
    test.setTimeout(45 * 60_000)
    await bringUpLanChat(app, window)

    // One reply comes from the Session that sent a Notification (an Answer), the other from
    // the Channel Session (a plain message), both sent before either has replied. Each
    // streams into its own draft and settles under the message that asked for it.
    const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
    try {
      await test.step('A reachable desktop Session sends a Notification', async () => {
        await app.shell.ensureSettingsClosed()
        await app.shell.startNewSession()
        await app.shell.makeOpenSessionReachable()
        const ready = await app.prepareAgentPreset()
        test.skip(!ready, 'Preset "Agent" is not available in this product mode')
        await app.runAgentTurn(NOTIFY_PROMPT, MainPage.TEXT_TIMEOUT)
        await expect(agentMessages(page, NOTIFICATION_TEXT).first()).toBeVisible({
          timeout: 60_000,
        })
      })

      await test.step('Answer it and message the Channel Session straight after', async () => {
        await answerAgentMessage(page, agentMessages(page, NOTIFICATION_TEXT).first(), MANGO)
        await sendMessage(page, PAPAYA)
      })

      await test.step('Each reply settles in its own bubble with its own text', async () => {
        const mango = agentRepliesTo(page, MANGO).first()
        const papaya = agentRepliesTo(page, PAPAYA).first()
        await expect(mango).toBeVisible({ timeout: MainPage.TEXT_TIMEOUT })
        await expect(papaya).toBeVisible({ timeout: MainPage.TEXT_TIMEOUT })
        await expect(mango).toContainText('MANGO')
        await expect(mango).not.toContainText('PAPAYA')
        await expect(papaya).toContainText('PAPAYA')
        await expect(papaya).not.toContainText('MANGO')
        await expect(draftBubbles(page)).toHaveCount(0)
      })
    } finally {
      await page.close()
    }
  })

  test('generates, edits, then animates a lizard over the LAN page', async ({
    app,
    window,
    electronApp,
  }) => {
    // Install + 3 real generations (incl. a video, each possibly pulling a model
    // in-channel) far exceed the default timeout — match the desktop full-flow budget.
    test.setTimeout(45 * 60_000)
    await bringUpLanChat(app, window)

    // The LAN version of the assistant's image → edit → video flow: ask the Channel
    // Session, over the served page, to create a lizard, edit it, then animate it, and
    // assert each generation renders inline (photo/video events → <img>/<video>).
    const page = await openLocalWebChat(electronApp, BASE_URL, LOCAL_WEB_PASSWORD)
    try {
      await test.step('Generate the lizard image → expect an inline image', async () => {
        await sendAndAwaitMedia(page, MEDIA_PROMPTS.generateImage, 'image', MainPage.IMAGE_TIMEOUT)
        expect(await lanImages(page).count()).toBeGreaterThanOrEqual(1)
      })

      await test.step('Edit the image (sunglasses + hair) → expect a second inline image', async () => {
        await sendAndAwaitMedia(page, MEDIA_PROMPTS.editImage, 'image', MainPage.IMAGE_TIMEOUT)
        expect(await lanImages(page).count()).toBeGreaterThanOrEqual(2)
      })

      await test.step('Animate the image with LTX → expect an inline video', async () => {
        await sendAndAwaitMedia(page, MEDIA_PROMPTS.animateToVideo, 'video', MainPage.VIDEO_TIMEOUT)
        expect(await lanVideos(page).count()).toBeGreaterThanOrEqual(1)
      })
    } finally {
      await page.close()
    }
  })
})
