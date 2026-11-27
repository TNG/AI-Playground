import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'

/** Off by default; turning it off removes the Hide buttons but leaves hidden messages hidden. */
export const useMessageHiding = defineStore('messageHiding', () => {
  const enabled = ref(false)

  const prefs = makeFileBackedPreference({ section: 'messageHiding', refs: { enabled } })
  if (import.meta.hot) import.meta.hot.dispose(() => prefs.dispose())

  return {
    enabled,
    init: () => prefs.init(),
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMessageHiding, import.meta.hot))
}
