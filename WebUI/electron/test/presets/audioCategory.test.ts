import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIO_CATEGORY, PresetSchema, type ChatPreset } from '@/assets/js/store/presets'
import { AUDIO_PRESET_NAMES } from '@/assets/js/store/conversationThreads'

// Pin test for the Chat / Audio split. The speech presets (Text to Speech, Speech to
// Text) are chat-*type* presets — they reuse the chat message rendering, though not
// its history — but they belong to the Audio mode, which is derived purely from their
// `category`. A speech preset that slips back into the `chat` category would show up
// in the Chat picker and put a record/synthesize surface where a chat prompt belongs.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const presetsDir = path.resolve(__dirname, '../../../../modes/base/presets')

function loadChatTypePresets(): { file: string; preset: ChatPreset }[] {
  return readdirSync(presetsDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => ({
      file,
      preset: PresetSchema.parse(JSON.parse(readFileSync(path.join(presetsDir, file), 'utf-8'))),
    }))
    .filter((entry): entry is { file: string; preset: ChatPreset } => entry.preset.type === 'chat')
}

const isSpeechPreset = (preset: ChatPreset) =>
  preset.ttsPreset === true || preset.sttPreset === true

describe('audio preset category', () => {
  const chatTypePresets = loadChatTypePresets()

  it('discovers the shipped chat-type presets', () => {
    expect(chatTypePresets.length).toBeGreaterThan(0)
    expect(chatTypePresets.filter(({ preset }) => isSpeechPreset(preset)).length).toBe(2)
  })

  it('puts every speech preset in the audio category', () => {
    const misplaced = chatTypePresets
      .filter(({ preset }) => isSpeechPreset(preset) && preset.category !== AUDIO_CATEGORY)
      .map(({ file, preset }) => `${file}: category=${preset.category ?? '(none)'}`)
    expect(misplaced, misplaced.join('\n')).toEqual([])
  })

  it('keeps non-speech chat presets out of the audio category', () => {
    const misplaced = chatTypePresets
      .filter(({ preset }) => !isSpeechPreset(preset) && preset.category === AUDIO_CATEGORY)
      .map(({ file }) => file)
    expect(misplaced, misplaced.join('\n')).toEqual([])
  })

  // The hydration backfill that moves pre-split threads into the Audio history has
  // only their stamped preset *name* to go on (it runs before the catalog loads), so
  // a speech preset missing from that list would leave its threads in the Assistant's.
  it('names every audio preset in the thread-kind backfill list', () => {
    const audioPresets = chatTypePresets
      .filter(({ preset }) => preset.category === AUDIO_CATEGORY)
      .map(({ preset }) => preset.name)
    expect([...audioPresets].sort()).toEqual([...AUDIO_PRESET_NAMES].sort())
  })
})
