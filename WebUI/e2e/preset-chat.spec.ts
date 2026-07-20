import { test } from './fixtures'

// One smoke test per chat preset: install backends, select the preset, (optionally
// attach a fixture), send a prompt and assert a non-empty, well-formed text reply.
// Excludes "aiDAPTIV™" (Phison) and "Home Agent" per request; "Agentic" has its own
// richer flow in install-backends.spec.ts. A preset not offered in the running
// product mode skips itself (see AppDriver.runChatPreset).

type ChatCase = {
  preset: string
  prompt: string
  attach?: 'image' | 'document'
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
  },
]

test.describe('Chat presets', () => {
  for (const { preset, prompt, attach } of CHAT_PRESETS) {
    test(`"${preset}" preset replies to a prompt`, async ({ app }) => {
      test.setTimeout(40 * 60_000)
      await app.installAllBackends()
      await app.runChatPreset({ preset, prompt, attach })
    })
  }
})
