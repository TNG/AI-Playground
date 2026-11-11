import { test } from './fixtures'

// Assistant as a chat: plain text, reasoning, and a Session document the answer must come
// from. aiDAPTIV™ is left out; media and speech have their own specs.

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
      await app.runChatPreset({ preset, prompt, attach, doc })
    })
  }
})
