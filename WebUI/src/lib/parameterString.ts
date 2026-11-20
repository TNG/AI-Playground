/**
 * Split a parameter string into argv tokens the way a shell would, so a flag
 * can carry a sentence: `--reasoning-budget-message "time to act"` is two
 * tokens, not four. The quotes are shell syntax and are dropped — these tokens
 * go straight to `spawn`, with no shell to strip them later.
 */
export function splitParameterString(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let pending = false
  let quote: '"' | "'" | null = null
  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      pending = true
      continue
    }
    if (/\s/.test(char)) {
      if (pending) tokens.push(current)
      current = ''
      pending = false
      continue
    }
    current += char
    pending = true
  }
  if (pending) tokens.push(current)
  return tokens
}
