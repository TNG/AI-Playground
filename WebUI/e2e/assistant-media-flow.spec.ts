import { test, expect } from './fixtures'
import { MainPage } from './pages/MainPage'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'

// Assistant on the agent harness, through its media capability: generate an image,
// edit it, then animate it into a video, one turn each.

const PROMPTS = {
  // Directive + demands a short explicit answer so the reasoning model closes the turn
  // with a real reply instead of a reasoning-only (empty-answer) turn.
  presetPreference:
    'When generating an image, use the Pro 2 preset unless told otherwise; when editing ' +
    'an image, use Edit By Prompt 2 unless told otherwise. Reply with a brief one-sentence ' +
    'confirmation and nothing else.',
  generateImage:
    'Generate an image of a lizard character, he is muscular fun and friendly and designed for an animated film. He is a surfer dude, and with a goofy but friendly vibe. Generate in 1:1 aspect ratio',
  editImage: 'Edit this image giving this character sunglasses and classic surfer hair',
  animateToVideo:
    'Lets bring this image to life. Animate this using LTX.2.3 i2v image to video. Have him waving hi and saying Hey Dudes, then jumping back into a cool pose that is consistent with his surfer, goofy character',
}

test.describe('Assistant — agentic media flow', () => {
  test('installs backends, then the assistant runs the image → edit → video flow', async ({
    app,
  }) => {
    // Install + 4 real generations (incl. a video) far exceed the default timeout.
    test.setTimeout(45 * 60_000)

    await app.installAllBackends()

    await test.step(`Select the "${HARNESS_CHAT_PRESET}" preset`, async () => {
      await app.main.selectPreset('Assistant', HARNESS_CHAT_PRESET)
    })

    // Back to the preset's shipped defaults (model included) before this flow sets
    // its own tools and generation budget — see AppDriver.resetPresetDefaults.
    await app.resetPresetDefaults()

    // Enforce Assistant's default capabilities and media tools (every workflow on).
    // Enforced rather than assumed, because saved Default Settings outlive a run.
    await app.configureAgenticTools()

    // Give the reasoning model room to emit a final answer (max tokens up, thinking
    // off) — otherwise the first turn can finish reasoning-only with an empty reply.
    await app.relaxChatGenerationBudget()

    await test.step('Prompt 1: set preset preferences → expect a text reply', async () => {
      await app.main.sendPrompt(PROMPTS.presetPreference)
      // Waits for the turn to go idle, then asserts the actual reply text is on
      // screen — not just the end of the reasoning trace.
      await app.main.waitForAssistantAnswer()
      expect(await app.main.lastAssistantText()).not.toEqual('')
      await app.main.assertWellFormedResponse()
      // A plain text reply — no media generated yet.
      expect(await app.main.generatedImages.count()).toBe(0)
      expect(await app.main.generatedVideos.count()).toBe(0)
    })

    await test.step('Prompt 2: generate the lizard image → expect an image', async () => {
      await app.main.sendPrompt(PROMPTS.generateImage)
      // The agent pulls the image model mid-turn; confirm the download dialog when
      // it appears, then wait for the generation to finish.
      await app.waitForAgenticMediaTurn(MainPage.IMAGE_TIMEOUT)
      await app.main.assertNoGenerationError()
      await app.main.assertWellFormedResponse()
      expect(await app.main.generatedImages.count()).toBeGreaterThanOrEqual(1)
    })

    await test.step('Prompt 3: edit the image (sunglasses + hair) → expect another image', async () => {
      await app.main.sendPrompt(PROMPTS.editImage)
      await app.waitForAgenticMediaTurn(MainPage.IMAGE_TIMEOUT)
      await app.main.assertNoGenerationError()
      await app.main.assertWellFormedResponse()
      expect(await app.main.generatedImages.count()).toBeGreaterThanOrEqual(2)
    })

    await test.step('Prompt 4: animate the image with LTX → expect a video', async () => {
      await app.main.sendPrompt(PROMPTS.animateToVideo)
      await app.waitForAgenticMediaTurn(MainPage.VIDEO_TIMEOUT)
      await app.main.assertNoGenerationError()
      await app.main.assertWellFormedResponse()
      expect(await app.main.generatedVideos.count()).toBeGreaterThanOrEqual(1)
    })
  })
})
