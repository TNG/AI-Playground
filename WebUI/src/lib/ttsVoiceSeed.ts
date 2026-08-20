/**
 * Seeds for Qwen3-TTS voice-design synthesis.
 *
 * Voice design samples a speaker from a natural-language description, so the
 * *same* description produces a different-sounding person on every call unless
 * the sampler is seeded. A saved voice therefore carries a seed: pinning it is
 * what makes "come back later and generate more speech in Tammy's voice"
 * actually return Tammy.
 */

/** Upper bound (exclusive) for seeds — keeps them inside a torch-friendly int32. */
const SEED_RANGE = 2 ** 31

/**
 * Deterministic seed derived from a voice's name + description (FNV-1a).
 * Used for voices saved before seeds existed, so they too become reproducible
 * without a migration — their seed is simply a function of what was persisted.
 */
export function stableVoiceSeed(name: string, instruct: string): number {
  const input = `${name.trim().toLowerCase()}\n${instruct.trim()}`
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    // FNV prime, via shifts to stay in 32-bit integer math.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return hash % SEED_RANGE
}

/** A fresh random seed — used when the user re-rolls a saved voice. */
export function randomVoiceSeed(): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] % SEED_RANGE
}

/** The seed to synthesize with: the pinned one, else the description-derived one. */
export function seedForVoice(voice: { name: string; instruct: string; seed?: number }): number {
  return Number.isInteger(voice.seed)
    ? (voice.seed as number)
    : stableVoiceSeed(voice.name, voice.instruct)
}
