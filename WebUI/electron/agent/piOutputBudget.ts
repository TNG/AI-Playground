import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'

// pi-ai caps every request at `contextWindow − estimated prompt − 4096`, floored at
// 1 token. Auto-compact only fires above `window − reserve` (piCompaction.ts), so on
// an 8k–16k window a step is cut to a token or a few hundred long before then and
// the turn ends empty. llama-server already stops generating at n_ctx, so a local
// llama.cpp request gets the step budget back instead.

export function createOutputBudgetExtension(maxTokens: number): ExtensionFactory {
  return (pi) => {
    pi.on('before_provider_request', (event) => {
      if (typeof event.payload !== 'object' || event.payload === null) return
      const body = event.payload as Record<string, unknown>
      const field = 'max_completion_tokens' in body ? 'max_completion_tokens' : 'max_tokens'
      const current = body[field]
      if (typeof current !== 'number' || current >= maxTokens) return
      return { ...body, [field]: maxTokens }
    })
  }
}
