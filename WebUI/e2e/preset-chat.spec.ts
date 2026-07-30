import { test } from './fixtures'

// One smoke test per chat preset: install backends, select the preset, (optionally
// attach a fixture), send a prompt and assert the expected result — a non-empty,
// well-formed text reply for normal chat presets, or a playable audio result for the
// Text-to-Speech preset. Excludes "aiDAPTIV™" (Phison) and "Home Agent" per request;
// "Agentic" has its own richer flow in install-backends.spec.ts. A preset not offered
// in the running product mode skips itself.

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
  { preset: 'Basic Chat', prompt: 'In one short sentence, what is a large language model?' },
  { preset: 'Advanced Chat', prompt: 'In one short sentence, what is a large language model?' },
  { preset: 'Reasoning', prompt: 'What is 17 multiplied by 23? Reply with just the number.' },
  { preset: 'NPU Chat', prompt: 'In one short sentence, what is a large language model?' },
  {
    preset: 'Vision',
    prompt: 'Describe what you see in this image in one short sentence.',
    attach: 'image',
  },
  {
    preset: 'Chat with RAG',
    prompt:
      'According to the attached document, what is the secret passphrase for the AI Playground e2e suite?',
    attach: 'document',
    doc: 'txt',
    label: 'txt source',
  },
  {
    preset: 'Chat with RAG',
    prompt:
      'According to the attached document, what is the secret passphrase for the AI Playground e2e suite?',
    attach: 'document',
    doc: 'pdf',
    label: 'pdf source',
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
