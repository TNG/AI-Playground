import { test, expect } from './fixtures'
import { MainPage } from './pages/MainPage'

// The chat preset that puts the assistant in agentic mode (built-in tools on).
const AGENTIC_PRESET = 'Agentic'

const PROMPTS = {
  presetPreference:
    'When generating an image use Pro 2 preset unless told otherwise. If editing an image use Edit By Prompt 2 unless told otherwise',
  generateImage:
    'Generate an image of a lizard character, he is muscular fun and friendly and designed for an animated film. He is a surfer dude, and with a goofy but friendly vibe. Generate in 1:1 aspect ratio',
  editImage: 'Edit this image giving this character sunglasses and classic surfer hair',
  animateToVideo:
    'Lets bring this image to life. Animate this using LTX.2.3 i2v image to video. Have him waving hi and saying Hey Dudes, then jumping back into a cool pose that is consistent with his surfer, goofy character',
}

test.describe('Backend installation', () => {
  test('installs backends, then runs the agentic image → edit → video flow', async ({ app }) => {
    // Install + 4 real generations (incl. a video) far exceed the default timeout.
    test.setTimeout(45 * 60_000)

    await app.installAllBackends()

    await test.step('Switch to agentic mode (Chat + "Agentic" preset)', async () => {
      await app.main.selectPreset('Chat', AGENTIC_PRESET)
    })

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
