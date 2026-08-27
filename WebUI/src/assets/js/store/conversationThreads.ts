import type { AipgUiMessage } from './openAiCompatibleChat'
import type { Preset } from './presets'
import { presetToMode } from '@/lib/presetModes'
import { currentPresetName } from '@/lib/presetRenames'

// ── Which history a conversation belongs to ──────────────────────────────────
//
// One conversation store holds every chat-like thread, so the kind is what keeps
// the three lists apart: the Assistant's own threads, the remote Home Agent ones,
// and the Audio mode's (Text to Speech takes, Speech to Text transcripts). Pure
// helpers, no store imports, so they are unit-tested directly and the store stays
// wiring.

export type ThreadKind = 'main' | 'homeAgent' | 'audio'

/**
 * Per-conversation inference profile snapshot. Stamped on every outbound
 * generate/regenerate so the thread is reproducible and "revisit = reactivate"
 * works in the Chat UI.
 */
export type ConversationThreadMeta = {
  presetName: string
  variant?: string | null
  kind?: ThreadKind
}

/**
 * The shipped presets that own the Audio history. Named rather than looked up,
 * because the hydration backfill below runs before the preset catalog is loaded.
 * A preset added to the audio category must be listed here too — pinned by
 * `audioCategory.test.ts`.
 */
export const AUDIO_PRESET_NAMES = ['Text to Speech', 'Speech to Text']

/** Whether a stored preset name is one of the speech presets. */
export function isAudioPresetName(presetName: string | null | undefined): boolean {
  if (!presetName) return false
  return AUDIO_PRESET_NAMES.includes(currentPresetName(presetName))
}

/**
 * Which history a thread belongs in, given the preset that just ran in it. A Home
 * Agent thread stays remote whatever preset drove it; a speech preset files the
 * thread under Audio, and once filed it stays there. Falls back to the preset's
 * name for a preset the catalog does not (yet) hold.
 */
export function threadKindForPreset(
  presetName: string,
  existingKind: ThreadKind | undefined,
  presets: Preset[],
): ThreadKind {
  if (existingKind === 'homeAgent') return 'homeAgent'
  const preset = presets.find((entry) => entry.name === presetName)
  const isAudio = preset ? presetToMode(preset) === 'audio' : isAudioPresetName(presetName)
  return isAudio ? 'audio' : (existingKind ?? 'main')
}

export function threadKindOf(
  meta: Record<string, ConversationThreadMeta> | undefined,
  conversationKey: string,
): ThreadKind {
  return meta?.[conversationKey]?.kind ?? 'main'
}

/**
 * A conversation key no thread already holds. Keys are minted from the clock, and
 * two kinds can now be minted in the same millisecond (switching mode allocates
 * the other list's first draft), which would make them one thread.
 */
export function mintThreadKey(list: Record<string, unknown>): string {
  let key = Date.now()
  while (String(key) in list) key += 1
  return String(key)
}

/**
 * Find or allocate the "current empty draft" of one kind — i.e. that kind's most
 * recently inserted conversation, reused when empty so we don't accumulate a long
 * tail of empty drafts.
 *
 * Only the kind's own tail is considered. Reusing another kind's empty thread
 * would silently retitle it AND, via the activeKey watcher in `textInference`,
 * snap the desktop preset to that thread's preset — observable as "first click on
 * another preset bounces back, second click sticks".
 */
export function findOrCreateEmptyThread(
  list: Record<string, AipgUiMessage[]>,
  meta: Record<string, ConversationThreadMeta> | undefined,
  kind: ThreadKind = 'main',
): string {
  const keys = Object.keys(list)
  let latestOfKind: string | undefined
  for (let i = keys.length - 1; i >= 0; i--) {
    if (threadKindOf(meta, keys[i]) !== kind) continue
    latestOfKind = keys[i]
    break
  }

  if (latestOfKind && list[latestOfKind].length === 0) {
    return latestOfKind
  }

  const newKey = mintThreadKey(list)
  list[newKey] = []
  return newKey
}

/**
 * The conversation to open for a kind: the remembered one when it still exists
 * and still belongs to that kind, else the newest of that kind, else nothing (the
 * caller allocates a draft).
 */
export function resolveThreadForKind(
  list: Record<string, AipgUiMessage[]>,
  meta: Record<string, ConversationThreadMeta> | undefined,
  kind: ThreadKind,
  rememberedKey?: string | null,
): string | null {
  if (rememberedKey && list[rememberedKey] && threadKindOf(meta, rememberedKey) === kind) {
    return rememberedKey
  }
  const keys = Object.keys(list).filter((key) => threadKindOf(meta, key) === kind)
  if (keys.length === 0) return null
  return keys.sort((a, b) => (parseInt(b) || 0) - (parseInt(a) || 0))[0]
}

/**
 * Move threads held with a speech preset into the Audio history. Installs from
 * before Audio had its own list stamped them `main`, so their synthesized takes
 * and transcripts would sit among the Assistant's conversations.
 */
export function backfillAudioThreadKind(meta: Record<string, ConversationThreadMeta>): void {
  for (const entry of Object.values(meta)) {
    if (entry.kind === 'homeAgent' || entry.kind === 'audio') continue
    if (isAudioPresetName(entry.presetName)) entry.kind = 'audio'
  }
}
