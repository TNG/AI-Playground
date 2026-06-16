/**
 * Shared helpers for naming llama-server KV cache dumps. Lives in its own module
 * so both `openAiCompatibleChat` (save/restore) and `conversations` (cleanup on
 * delete) can use it without importing each other.
 *
 * Filename scheme: kv__<kind>__<convKey>__<modelHash>.bin
 * - <kind>      main | homeAgent — drives "keep only latest per kind" retention.
 * - <convKey>   sanitized conversation id (the legacy Home Agent key contains
 *               `__`, which would break parsing, so we strip non-alphanumerics).
 * - <modelHash> short hash of the active model id so a dump is never restored
 *               into a slot running a different model.
 */

export function sanitizeConvKey(convKey: string): string {
  return convKey.replace(/[^a-zA-Z0-9]/g, '-')
}

export function hashModelId(model: string): string {
  // djb2 — small, stable, no crypto dependency needed for a cache-busting tag.
  let h = 5381
  for (let i = 0; i < model.length; i++) {
    h = ((h << 5) + h + model.charCodeAt(i)) >>> 0
  }
  return h.toString(16)
}

export function buildKvCacheFilename(kind: string, convKey: string, model: string): string {
  return `kv__${kind}__${sanitizeConvKey(convKey)}__${hashModelId(model)}.bin`
}
