import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'
import type { ChannelKind } from './channels/types'

/** Each Channel's Channel Session; neither the desktop's open Session nor a message moves another's. */
export const useChannelSessionPointers = defineStore('channelSessionPointers', () => {
  const pointers = ref<Partial<Record<ChannelKind, string>>>({})

  const prefs = makeFileBackedPreference({ section: 'channelSessions', refs: { pointers } })
  if (import.meta.hot) import.meta.hot.dispose(() => prefs.dispose())

  function get(kind: ChannelKind): string | null {
    return pointers.value[kind] ?? null
  }

  function set(kind: ChannelKind, sessionRef: string | null): void {
    const next = { ...pointers.value }
    if (sessionRef) next[kind] = sessionRef
    else delete next[kind]
    pointers.value = next
  }

  return { pointers, get, set, init: () => prefs.init() }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useChannelSessionPointers, import.meta.hot))
}
