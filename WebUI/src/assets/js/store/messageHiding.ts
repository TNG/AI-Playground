import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { makeFileBackedPreference } from '@/lib/fileBackedPreferences'

/**
 * The switch that gates the Hide feature: off by default, so the possibility
 * stays hard to find until it is turned on here. Turning it off never brings
 * hidden messages back — they stay hidden; it only takes the Hide buttons away.
 */
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
