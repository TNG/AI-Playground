import { test } from './fixtures'

// Smoke tests covering the unified "Assistant" chat preset across its capabilities
// (plain text, reasoning, vision, RAG) plus the separate Text-to-Speech preset:
// install backends, select the preset, (optionally attach a fixture), send a prompt
// and assert the expected result — a non-empty, well-formed text reply, or a playable
// audio result for the Text-to-Speech preset. Excludes "aiDAPTIV™" (Phison) and
// "Home Agent" per request; the Assistant agentic/tool flow has its own richer
// coverage in install-backends.spec.ts. A preset not offered in the running product
// mode skips itself.

type ChatCase = {
  preset: string
  prompt: string
  attach?: 'image' | 'document'
  doc?: 'txt' | 'pdf'
  /** 'tts' presets synthesize audio from `prompt` instead of replying with text. Defaults to 'text'. */
  kind?: 'text' | 'tts'
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
  {
    preset: 'Text to Speech',
    prompt: 'Hello from the AI Playground end-to-end test suite.',
    kind: 'tts',
  },
]

test.describe('Chat presets', () => {
  for (const { preset, prompt, attach, doc, kind, label } of CHAT_PRESETS) {
    const action = kind === 'tts' ? 'synthesizes audio from text' : 'replies to a prompt'
    const title = label ? `"${preset}" preset ${action} (${label})` : `"${preset}" preset ${action}`
    test(title, async ({ app }) => {
      test.setTimeout(40 * 60_000)
      await app.installAllBackends()

      if (kind === 'tts') {
        // The Text-to-Speech backend is feature-flagged and pulls a heavy model, so
        // it's installed on demand here rather than in installAllBackends.
        const ttsAvailable = await app.ensureTtsBackendInstalled()
        test.skip(
          !ttsAvailable,
          'Text-to-Speech is not available (feature flag off or unsupported mode)',
        )
        await app.runTtsPreset({ text: prompt })
      } else {
        await app.runChatPreset({ preset, prompt, attach, doc })
      }
    })
  }
})
