import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import type { Preset } from '@/assets/js/store/presets'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import {
  backfillAudioThreadKind,
  findOrCreateEmptyThread,
  isAudioPresetName,
  mintThreadKey,
  resolveThreadForKind,
  threadKindForPreset,
  type ConversationThreadMeta,
} from '@/assets/js/store/conversationThreads'
import { useConversations } from '@/assets/js/store/conversations'

// One store holds every chat-like conversation, so the thread kind is the only
// thing keeping the Assistant, Home Agent and Audio histories apart. These tests
// cover that: which list a thread is filed under, that neither list can hand the
// other its draft, and that threads from before Audio had its own list are moved.

const message = () => ({ id: 'm', role: 'user', parts: [] }) as unknown as AipgUiMessage

const TTS: Preset = {
  type: 'chat',
  category: 'audio',
  name: 'Text to Speech',
  backends: ['llamaCPP'],
  ttsPreset: true,
} as Preset

const CHAT: Preset = {
  type: 'chat',
  category: 'chat',
  name: 'Assistant',
  backends: ['llamaCPP'],
} as Preset

describe('isAudioPresetName', () => {
  it('recognizes the speech presets and nothing else', () => {
    expect(isAudioPresetName('Text to Speech')).toBe(true)
    expect(isAudioPresetName('Speech to Text')).toBe(true)
    expect(isAudioPresetName('Assistant')).toBe(false)
    expect(isAudioPresetName('')).toBe(false)
    expect(isAudioPresetName(undefined)).toBe(false)
  })
})

describe('mintThreadKey', () => {
  it('never returns a key the list already holds', () => {
    const taken = String(Date.now())
    const list = { [taken]: [] }
    expect(mintThreadKey(list)).not.toBe(taken)
  })
})

describe('findOrCreateEmptyThread', () => {
  it("reuses a kind's own empty draft", () => {
    const list: Record<string, AipgUiMessage[]> = { '1': [message()], '2': [] }
    expect(findOrCreateEmptyThread(list, {}, 'main')).toBe('2')
  })

  it('does not hand the Assistant an empty Audio draft', () => {
    const list: Record<string, AipgUiMessage[]> = { '1': [message()], '2': [] }
    const meta: Record<string, ConversationThreadMeta> = {
      '2': { presetName: 'Text to Speech', kind: 'audio' },
    }
    const key = findOrCreateEmptyThread(list, meta, 'main')
    expect(key).not.toBe('2')
    expect(list[key]).toEqual([])
  })

  it('does not hand Audio the Assistant’s empty draft', () => {
    const list: Record<string, AipgUiMessage[]> = { '1': [] }
    const key = findOrCreateEmptyThread(list, {}, 'audio')
    expect(key).not.toBe('1')
  })

  it('allocates when the kind’s latest thread has messages', () => {
    const list: Record<string, AipgUiMessage[]> = { '1': [], '2': [message()] }
    const meta: Record<string, ConversationThreadMeta> = {
      '2': { presetName: 'Text to Speech', kind: 'audio' },
    }
    const key = findOrCreateEmptyThread(list, meta, 'audio')
    expect(key).not.toBe('1')
    expect(key).not.toBe('2')
  })
})

describe('resolveThreadForKind', () => {
  const list: Record<string, AipgUiMessage[]> = { '1': [message()], '2': [message()] }
  const meta: Record<string, ConversationThreadMeta> = {
    '2': { presetName: 'Speech to Text', kind: 'audio' },
  }

  it('prefers the remembered thread', () => {
    expect(resolveThreadForKind(list, meta, 'audio', '2')).toBe('2')
  })

  it('ignores a remembered thread of another kind, or one since deleted', () => {
    expect(resolveThreadForKind(list, meta, 'main', '2')).toBe('1')
    expect(resolveThreadForKind(list, meta, 'audio', '404')).toBe('2')
  })

  it('falls back to the newest of that kind, else nothing', () => {
    expect(resolveThreadForKind({ '1': [], '3': [] }, {}, 'main', null)).toBe('3')
    expect(resolveThreadForKind(list, meta, 'homeAgent', null)).toBeNull()
  })
})

describe('backfillAudioThreadKind', () => {
  it('moves threads held with a speech preset into the Audio history', () => {
    const meta: Record<string, ConversationThreadMeta> = {
      '1': { presetName: 'Text to Speech' },
      '2': { presetName: 'Speech to Text', kind: 'main' },
      '3': { presetName: 'Assistant', kind: 'main' },
      '4': { presetName: 'Home Agent', kind: 'homeAgent' },
    }
    backfillAudioThreadKind(meta)
    expect(meta['1'].kind).toBe('audio')
    expect(meta['2'].kind).toBe('audio')
    expect(meta['3'].kind).toBe('main')
    expect(meta['4'].kind).toBe('homeAgent')
  })
})

describe('threadKindForPreset', () => {
  const presets = [TTS, CHAT]

  it('files a speech preset’s thread under Audio', () => {
    expect(threadKindForPreset('Text to Speech', undefined, presets)).toBe('audio')
    expect(threadKindForPreset('Text to Speech', 'main', presets)).toBe('audio')
  })

  it('leaves a chat preset’s thread where it is', () => {
    expect(threadKindForPreset('Assistant', undefined, presets)).toBe('main')
    expect(threadKindForPreset('Assistant', 'audio', presets)).toBe('audio')
  })

  it('keeps a Home Agent thread remote whatever preset ran', () => {
    expect(threadKindForPreset('Text to Speech', 'homeAgent', presets)).toBe('homeAgent')
  })

  it('falls back to the name when the catalog has no such preset', () => {
    expect(threadKindForPreset('Speech to Text', undefined, [])).toBe('audio')
    expect(threadKindForPreset('Assistant', undefined, [])).toBe('main')
  })
})

describe('conversations store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('stamps the kind of an Audio draft, so it is listed under Audio', () => {
    const conversations = useConversations()
    const key = conversations.addNewConversation('audio')
    expect(conversations.getThreadKind(key)).toBe('audio')
    expect(conversations.activeKey).toBe(key)
  })

  it('keeps the Assistant and Audio drafts apart', () => {
    const conversations = useConversations()
    const audioKey = conversations.addNewConversation('audio')
    const mainKey = conversations.addNewConversation('main')
    expect(mainKey).not.toBe(audioKey)
    expect(conversations.getThreadKind(mainKey)).toBe('main')
  })

  it('returns each mode to the thread it left behind', async () => {
    const conversations = useConversations()
    const mainKey = conversations.addNewConversation('main')
    conversations.updateConversation([message()], mainKey)
    await nextTick()

    const audioKey = conversations.activateThreadForKind('audio')
    conversations.updateConversation([message()], audioKey)
    await nextTick()
    expect(audioKey).not.toBe(mainKey)

    expect(conversations.activateThreadForKind('main')).toBe(mainKey)
    await nextTick()
    expect(conversations.activateThreadForKind('audio')).toBe(audioKey)
  })

  it('allocates an Audio thread the first time the mode is entered', () => {
    const conversations = useConversations()
    const mainKey = conversations.addNewConversation('main')
    const audioKey = conversations.activateThreadForKind('audio')
    expect(audioKey).not.toBe(mainKey)
    expect(conversations.getThreadKind(audioKey)).toBe('audio')
  })

  it('never falls back to an Audio thread when the active one is gone', async () => {
    const conversations = useConversations()
    const mainKey = conversations.addNewConversation('main')
    conversations.updateConversation([message()], mainKey)
    const audioKey = conversations.activateThreadForKind('audio')
    await nextTick()

    conversations.deleteConversation(audioKey)
    await nextTick()
    expect(conversations.activeKey).toBe(mainKey)
  })
})
