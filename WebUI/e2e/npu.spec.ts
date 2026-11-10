import { test } from './fixtures'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'

// The NPU caps the prompt at 8k, which Assistant's default capabilities have to fit
// inside. Skips without OpenVINO or an NPU device.

const HAIKU_PROMPT = 'Write a haiku about a friendly, goofy surfer-dude lizard.'

test.describe('NPU', () => {
  test('Assistant composes a haiku on the NPU (OpenVINO)', async ({ app }) => {
    // Install + backend restart on device switch + a text turn exceed the default timeout.
    test.setTimeout(30 * 60_000)

    await app.installAllBackends()

    await test.step(`Select the "${HARNESS_CHAT_PRESET}" preset`, async () => {
      await app.main.selectPreset('Chat', HARNESS_CHAT_PRESET)
    })

    // Start from the preset's shipped defaults, not from what a previous run saved
    // for it — see AppDriver.resetPresetDefaults.
    await app.resetPresetDefaults()

    await app.runNpuHaiku(HAIKU_PROMPT)
  })
})
