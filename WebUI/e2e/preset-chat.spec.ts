import { test } from './fixtures'

// Smoke tests covering the unified "Assistant" chat preset across its capabilities
// (plain text, reasoning, vision, RAG): install backends, select the preset,
// (optionally attach a fixture), send a prompt and assert a non-empty, well-formed
// text reply. Excludes "aiDAPTIV™" (Phison) and "Home Agent" per request; the
// Assistant agentic/tool flow has its own richer coverage in
// assistant-media-flow.spec.ts, and the speech presets live in the Audio mode with
// their own specs (preset-tts, preset-tts-kokoro, preset-stt). A preset not offered
// in the running product mode skips itself.

type ChatCase = {
  preset: string
  prompt: string
  attach?: 'image' | 'document'
  doc?: 'txt' | 'pdf'
  /** Appended to the test title to distinguish same-preset variants (e.g. txt vs pdf). */
  label?: string
}

const CHAT_PRESETS: ChatCase[] = [
  {
    preset: 'Assistant',
    prompt: 'In one short sentence, what is a large language model?',
    label: 'plain text',
  },
  {
    preset: 'Assistant',
    prompt: 'What is 17 multiplied by 23? Reply with just the number.',
    label: 'reasoning',
  },
  // NOTE: A vision case is intentionally omitted here. Attaching an image is gated
  // on the selected model supporting vision (PromptArea.vue `canAttachImages`), and
  // Assistant's default model is text-only. Exercising vision now requires selecting
  // a vision-capable model in the picker, which `runChatPreset` doesn't do.
  {
    preset: 'Assistant',
    prompt:
      'According to the attached document, what is the secret passphrase for the AI Playground e2e suite?',
    attach: 'document',
    doc: 'txt',
    label: 'RAG txt source',
  },
  {
    preset: 'Assistant',
    prompt:
      'According to the attached document, what is the secret passphrase for the AI Playground e2e suite?',
    attach: 'document',
    doc: 'pdf',
    label: 'RAG pdf source',
  },
]

test.describe('Chat presets', () => {
  for (const { preset, prompt, attach, doc, label } of CHAT_PRESETS) {
    const title = label
      ? `"${preset}" preset replies to a prompt (${label})`
      : `"${preset}" preset replies to a prompt`
    test(title, async ({ app }) => {
      test.setTimeout(40 * 60_000)
      await app.installAllBackends()

      if (kind === 'tts') {
        // The Text-to-Speech backend pulls a heavy model, so it's installed on demand
        // here rather than in installAllBackends. It must be available — TTS is a
        // required capability in this suite, so an unavailable backend fails the test
        // rather than skipping.
        const ttsAvailable = await app.ensureTtsBackendInstalled()
        expect(ttsAvailable, 'Text-to-Speech must be available (mode supported)').toBe(true)
        await app.runTtsPreset({
          text: prompt,
          newVoice: {
            name: 'E2E Custom Voice',
            description: 'A calm, warm middle-aged British man, reassuring and clear.',
            text: 'This line is spoken by a custom voice created during the end-to-end test.',
          },
        })
      } else {
        await app.runChatPreset({ preset, prompt, attach, doc })
      }
    })
  }
})
