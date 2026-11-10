import { test } from './fixtures'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'

// Assistant-on-NPU smoke: pin Assistant to the OpenVINO backend and switch its
// inference device to the NPU, then confirm the model composes a haiku (a plain text
// reply). The NPU caps the prompt at 8k, which Assistant's default capabilities have to
// fit inside. Skips where OpenVINO isn't offered in this product mode or the machine has
// no NPU inference device — NPU hardware is environment-specific. The default-GPU
// override from installAllBackends is irrelevant here: this test selects the NPU device
// explicitly afterwards.

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
