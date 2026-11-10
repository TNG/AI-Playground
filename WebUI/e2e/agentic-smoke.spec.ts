import { test, expect } from './fixtures'

// Quick agentic smoke — the reference flow for `npm run e2e:fast`. Installs backends,
// selects the "Assistant" preset (which runs on the Pi agent harness), then runs two
// turns: a text turn ("write a haiku") and an image turn ("turn it into an image").
// This is the cheap gate; the full agentic flow (image → edit → video) lives in
// assistant-media-flow.spec.ts and runs in `npm run e2e:full`.
//
// The chat backend is pinned explicitly and the smoke runs once per backend: the
// preset otherwise uses whichever backend happens to be running, which has masked
// backend-specific breakage (e.g. llama.cpp Vulkan device-loss vs. OVMS URL/graph
// issues). llama.cpp is the universal default; OpenVINO is only offered in Intel/
// OpenVINO product modes, so its variant skips when the picker doesn't list it.

// Backend picker labels (see SpecificSettingsPage.availableBackends).
const CHAT_BACKENDS = [
  { label: 'llamaCPP - GGUF', name: 'llama.cpp', optional: false },
  { label: 'OpenVINO', name: 'OpenVINO', optional: true },
] as const

const PROMPTS = {
  haiku: 'Write a haiku about a friendly, goofy surfer-dude lizard.',
  // Pin the "Draft Image" preset (fast SD1.5, 512x512) so this cheap gate uses the
  // quickest image path rather than whatever preset the agent would otherwise pick.
  toImage: 'Now turn that haiku into an image using the "Draft Image" preset.',
}

test.describe('Agentic smoke', () => {
  for (const backend of CHAT_BACKENDS) {
    test(`writes a haiku and turns it into an image on ${backend.name}`, async ({ app }) => {
      // Install + a text turn + one real image generation exceed the default timeout.
      test.setTimeout(30 * 60_000)

      await app.installAllBackends()

      const ran = await app.runAgentPreset({
        prompt: PROMPTS.haiku,
        imagePrompt: PROMPTS.toImage,
        backend: backend.label,
      })
      expect(ran || backend.optional, `the ${backend.name} backend is not offered`).toBe(true)
      test.skip(!ran, `${backend.name} chat backend is not available in this product mode`)
    })
  }
})
