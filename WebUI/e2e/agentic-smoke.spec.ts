import { test, expect } from './fixtures'
import { MainPage } from './pages/MainPage'

// Quick agentic smoke — the reference flow for `npm run e2e:fast`. Installs backends,
// switches to the agentic chat preset, then runs two turns: a text turn ("write a
// haiku") and an image turn ("turn it into an image"). This is the cheap gate; the
// full four-generation agentic flow (image → edit → video) lives in
// install-backends.spec.ts and runs in `npm run e2e:full`.

// The chat preset that puts the assistant in agentic mode (built-in tools on).
const AGENTIC_PRESET = 'Agentic'

const PROMPTS = {
  haiku: 'Write a haiku about a friendly, goofy surfer-dude lizard.',
  toImage: 'Now turn that haiku into an image.',
}

test.describe('Agentic smoke', () => {
  test('installs backends, then writes a haiku and turns it into an image', async ({ app }) => {
    // Install + a text turn + one real image generation exceed the default timeout.
    test.setTimeout(30 * 60_000)

    await app.installAllBackends()

    await test.step('Switch to agentic mode (Chat + "Agentic" preset)', async () => {
      await app.main.selectPreset('Chat', AGENTIC_PRESET)
    })

    await test.step('Prompt 1: write a haiku → expect a text reply', async () => {
      await app.main.sendPrompt(PROMPTS.haiku)
      // Waits for the turn to go idle, then asserts the actual reply text is on
      // screen — not just the end of the reasoning trace.
      await app.main.waitForAssistantAnswer()
      expect(await app.main.lastAssistantText()).not.toEqual('')
      await app.main.assertWellFormedResponse()
      // A plain text reply — no media generated yet.
      expect(await app.main.generatedImages.count()).toBe(0)
    })

    await test.step('Prompt 2: turn the haiku into an image → expect an image', async () => {
      await app.main.sendPrompt(PROMPTS.toImage)
      await app.main.waitUntilIdle(MainPage.IMAGE_TIMEOUT)
      await app.main.assertNoGenerationError()
      await app.main.assertWellFormedResponse()
      expect(await app.main.generatedImages.count()).toBeGreaterThanOrEqual(1)
    })
  })
})
